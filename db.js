const { Pool } = require('pg');
try { require('dotenv').config(); } catch (e) {}
const { hashPassword } = require('./authUtils');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'diario_classe',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Se o PostgreSQL cair ou reiniciar, a conexão ociosa emite 'error'. Sem este tratamento,
// o Node encerrava o processo e o sistema inteiro saía do ar. O pool reconecta sozinho
// na próxima consulta quando o banco voltar.
pool.on('error', (err) => {
  console.error(' Conexão com o PostgreSQL perdida (o app continua no ar e reconecta):', err.message);
});

/**
 * Mantém coerentes o professor responsável e o status de matrícula do aluno.
 * Regra: o responsável precisa ser um professor ativo; se o aluno tem aulas ativas
 * na grade e o responsável atual não dá nenhuma delas, assume o professor com mais
 * aulas com o aluno. Sem professor, o aluno ativo fica "aguardando_professor".
 */
async function syncStudentTeacher(db, studentId) {
  const stRes = await db.query(`
    SELECT s.id, s.status, s.enrollment_status, s.assigned_teacher_id,
           u.role AS teacher_role, u.status AS teacher_status
    FROM students s
    LEFT JOIN users u ON u.id = s.assigned_teacher_id
    WHERE s.id = $1
  `, [studentId]);
  const st = stRes.rows[0];
  if (!st) return null;

  const schedRes = await db.query(`
    SELECT ts.teacher_id, COUNT(*) AS total, MIN(ts.id) AS first_id
    FROM teacher_schedules ts
    JOIN users u ON u.id = ts.teacher_id AND u.role = 'professor' AND u.status = 'ativo'
    WHERE ts.student_id = $1 AND ts.status = 'ativo'
    GROUP BY ts.teacher_id
    ORDER BY COUNT(*) DESC, MIN(ts.id) ASC
  `, [studentId]);

  let teacherId = st.assigned_teacher_id;
  const assignedIsValid = teacherId && st.teacher_role === 'professor' && st.teacher_status === 'ativo';
  if (!assignedIsValid) teacherId = null;
  if (schedRes.rows.length > 0 && !schedRes.rows.some(r => r.teacher_id === teacherId)) {
    teacherId = schedRes.rows[0].teacher_id;
  }

  let enrollment = st.enrollment_status;
  if (st.status === 'ativo') {
    if (!teacherId) enrollment = 'aguardando_professor';
    else if (!enrollment || enrollment === 'aguardando_professor') enrollment = 'ativo';
  }

  if (teacherId !== st.assigned_teacher_id || enrollment !== st.enrollment_status) {
    await db.query(
      'UPDATE students SET assigned_teacher_id = $1, enrollment_status = $2 WHERE id = $3',
      [teacherId, enrollment, studentId]
    );
  }
  return { assigned_teacher_id: teacherId, enrollment_status: enrollment };
}

/**
 * Correção única dos dados que ficaram inconsistentes antes das regras de validação.
 */
async function runConsistencyMigration(client) {
  console.log(' Aplicando migração de consistência dos dados...');

  // 1. Horários de usuários que não são professores ativos (ex.: admin) saem da grade
  await client.query(`
    UPDATE teacher_schedules SET status = 'inativo', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'ativo'
      AND teacher_id IN (SELECT id FROM users WHERE role <> 'professor' OR status <> 'ativo')
  `);

  // 2. Horários de alunos inativos saem da grade
  await client.query(`
    UPDATE teacher_schedules SET status = 'inativo', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'ativo'
      AND student_id IN (SELECT id FROM students WHERE status <> 'ativo')
  `);

  // 3. Aluno com aula na grade fica matriculado na matéria; professor fica vinculado à matéria que dá
  await client.query(`
    INSERT INTO student_subjects (student_id, subject_id)
    SELECT DISTINCT student_id, subject_id FROM teacher_schedules
    WHERE status = 'ativo' AND student_id IS NOT NULL AND subject_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  await client.query(`
    INSERT INTO teacher_subjects (user_id, subject_id)
    SELECT DISTINCT ts.teacher_id, ts.subject_id FROM teacher_schedules ts
    WHERE ts.status = 'ativo' AND ts.subject_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM teacher_subjects x WHERE x.user_id = ts.teacher_id AND x.subject_id = ts.subject_id)
  `);

  // 4. Alunos ativos sem professor e sem grade: assume o professor que mais lançou aulas para eles
  await client.query(`
    UPDATE students s SET assigned_teacher_id = x.teacher_id
    FROM (
      SELECT DISTINCT ON (cl.student_id) cl.student_id, cl.teacher_id
      FROM class_logs cl
      JOIN users u ON u.id = cl.teacher_id AND u.role = 'professor' AND u.status = 'ativo'
      GROUP BY cl.student_id, cl.teacher_id
      ORDER BY cl.student_id, COUNT(*) DESC, MAX(cl.class_date) DESC
    ) x
    WHERE x.student_id = s.id
      AND s.assigned_teacher_id IS NULL
      AND s.status = 'ativo'
      AND NOT EXISTS (SELECT 1 FROM teacher_schedules ts WHERE ts.student_id = s.id AND ts.status = 'ativo')
  `);

  // 5. Recalcula professor responsável e status de matrícula de todos os alunos
  const all = await client.query('SELECT id FROM students');
  for (const row of all.rows) {
    await syncStudentTeacher(client, row.id);
  }
  console.log(' Migração de consistência concluída.');
}

async function initDB(seedDataFn) {
  let retries = 5;
  while (retries > 0) {
    try {
      const client = await pool.connect();
      console.log(' Conectado com sucesso ao PostgreSQL!');
      
      await client.query(`
        -- Tabela de Usuários / Professores / Admin
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(150) NOT NULL,
          email VARCHAR(150) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          salt VARCHAR(64) NOT NULL,
          role VARCHAR(30) NOT NULL DEFAULT 'professor', -- 'admin' ou 'professor'
          status VARCHAR(20) DEFAULT 'ativo', -- 'ativo' ou 'inativo'
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Tabela de Matérias/Turmas
        CREATE TABLE IF NOT EXISTS subjects (
          id SERIAL PRIMARY KEY,
          code VARCHAR(50) UNIQUE NOT NULL,
          name VARCHAR(100) NOT NULL,
          sheet_gid VARCHAR(50),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Relacionamento Professor <-> Matérias/Turmas que leciona
        CREATE TABLE IF NOT EXISTS teacher_subjects (
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          subject_id INT REFERENCES subjects(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, subject_id)
        );

        -- Tabela de Alunos
        CREATE TABLE IF NOT EXISTS students (
          id SERIAL PRIMARY KEY,
          name VARCHAR(150) NOT NULL,
          objective_grade VARCHAR(100),
          start_date VARCHAR(30),
          end_date VARCHAR(30),
          status VARCHAR(20) DEFAULT 'ativo',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Relacionamento Aluno <-> Matérias
        CREATE TABLE IF NOT EXISTS student_subjects (
          student_id INT REFERENCES students(id) ON DELETE CASCADE,
          subject_id INT REFERENCES subjects(id) ON DELETE CASCADE,
          PRIMARY KEY (student_id, subject_id)
        );

        -- Registros de Aula / Diário de Classe
        CREATE TABLE IF NOT EXISTS class_logs (
          id SERIAL PRIMARY KEY,
          student_id INT REFERENCES students(id) ON DELETE CASCADE,
          subject_id INT REFERENCES subjects(id) ON DELETE CASCADE,
          teacher_id INT REFERENCES users(id) ON DELETE SET NULL,
          class_date DATE NOT NULL DEFAULT CURRENT_DATE,
          class_time VARCHAR(10),
          status VARCHAR(20) NOT NULL DEFAULT 'presente', -- 'presente' ou 'falta'
          content TEXT,
          incidents TEXT DEFAULT 'Sem intercorrências',
          pedagogical_notes TEXT,
          teacher_name VARCHAR(100),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Migrações seguras de colunas existentes
        ALTER TABLE class_logs ADD COLUMN IF NOT EXISTS teacher_id INT REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE class_logs ADD COLUMN IF NOT EXISTS class_time VARCHAR(10);
        UPDATE class_logs SET class_time = '07:30' WHERE class_time IS NULL OR class_time = '';
        ALTER TABLE students ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ativo';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(30) NOT NULL DEFAULT 'professor';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ativo';

        -- Limpeza definitiva de estruturas legadas do Sheets
        ALTER TABLE class_logs DROP COLUMN IF EXISTS synced_to_sheets;
        ALTER TABLE class_logs DROP COLUMN IF EXISTS sheet_synced_at;
        ALTER TABLE class_logs DROP COLUMN IF EXISTS sheet_sync_error;
        DROP TABLE IF EXISTS sync_events;

        -- Colunas para Acesso dos Pais na tabela students
        ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_name VARCHAR(150);
        ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_email VARCHAR(150);
        ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_phone VARCHAR(50);
        ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_access_code VARCHAR(50);

        -- Vínculo de Aluno na tabela users para perfis de pais/responsáveis
        ALTER TABLE users ADD COLUMN IF NOT EXISTS student_id INT REFERENCES students(id) ON DELETE CASCADE;

        -- Tabela de Agenda do Aluno (Comunicação entre Escola/Professores e Pais)
        CREATE TABLE IF NOT EXISTS student_agenda (
          id SERIAL PRIMARY KEY,
          student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          author_id INT REFERENCES users(id) ON DELETE SET NULL,
          author_name VARCHAR(100),
          entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
          entry_time VARCHAR(10) DEFAULT '08:00',
          category VARCHAR(50) NOT NULL DEFAULT 'recado', -- 'recado', 'aviso', 'tarefa', 'elogio', 'desempenho'
          title VARCHAR(200) NOT NULL,
          content TEXT NOT NULL,
          is_important BOOLEAN DEFAULT false,
          read_by_parent BOOLEAN DEFAULT false,
          read_at TIMESTAMP WITH TIME ZONE,
          parent_response TEXT,
          parent_response_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Tabela de Grade de Horários dos Professores (Controlada pelo Admin, visualização para Professores)
        CREATE TABLE IF NOT EXISTS teacher_schedules (
          id SERIAL PRIMARY KEY,
          teacher_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject_id INT REFERENCES subjects(id) ON DELETE SET NULL,
          day_of_week INT NOT NULL, -- 1=Segunda, 2=Terça, 3=Quarta, 4=Quinta, 5=Sexta, 6=Sábado, 0=Domingo
          start_time VARCHAR(10) NOT NULL,
          end_time VARCHAR(10) NOT NULL,
          room_or_info VARCHAR(120) DEFAULT 'Sala Presencial / Online',
          notes TEXT,
          status VARCHAR(20) DEFAULT 'ativo',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Colunas para Matrícula e Recorrência de Aulas (Semanal, Quinzenal, Custom)
        ALTER TABLE students ADD COLUMN IF NOT EXISTS frequency_type VARCHAR(40) DEFAULT 'semanal';
        ALTER TABLE students ADD COLUMN IF NOT EXISTS custom_interval_days INT DEFAULT 7;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS preferred_days VARCHAR(50) DEFAULT '1';
        ALTER TABLE students ADD COLUMN IF NOT EXISTS preferred_time VARCHAR(10) DEFAULT '08:00';
        ALTER TABLE students ADD COLUMN IF NOT EXISTS duration_minutes INT DEFAULT 60;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS enrollment_status VARCHAR(30) DEFAULT 'ativo';
        ALTER TABLE students ADD COLUMN IF NOT EXISTS assigned_teacher_id INT REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE students ADD COLUMN IF NOT EXISTS enrollment_notes TEXT;

        -- Colunas para Vínculo de Aluno e Recorrência na Grade de Horários
        ALTER TABLE teacher_schedules ADD COLUMN IF NOT EXISTS student_id INT REFERENCES students(id) ON DELETE CASCADE;
        ALTER TABLE teacher_schedules ADD COLUMN IF NOT EXISTS frequency_type VARCHAR(40) DEFAULT 'semanal';
        ALTER TABLE teacher_schedules ADD COLUMN IF NOT EXISTS recurrence_interval_days INT DEFAULT 7;
        ALTER TABLE teacher_schedules ADD COLUMN IF NOT EXISTS start_date DATE DEFAULT CURRENT_DATE;
        ALTER TABLE teacher_schedules ADD COLUMN IF NOT EXISTS end_date DATE;

        -- Tabela de Salas & Ambientes de Aprendizagem
        CREATE TABLE IF NOT EXISTS classrooms (
          id SERIAL PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          type VARCHAR(30) NOT NULL DEFAULT 'presencial', -- 'presencial' ou 'online'
          capacity_students INT NOT NULL DEFAULT 4,
          capacity_teachers INT NOT NULL DEFAULT 1,
          resources JSONB DEFAULT '[]'::jsonb,
          description TEXT,
          status VARCHAR(20) DEFAULT 'ativo',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Vínculos de Sala e Limites em Matérias
        ALTER TABLE subjects ADD COLUMN IF NOT EXISTS classroom_id INT REFERENCES classrooms(id) ON DELETE SET NULL;
        ALTER TABLE subjects ADD COLUMN IF NOT EXISTS max_students INT DEFAULT 4;
        ALTER TABLE subjects ADD COLUMN IF NOT EXISTS required_resources JSONB DEFAULT '[]'::jsonb;
        ALTER TABLE subjects ADD COLUMN IF NOT EXISTS total_lessons INT DEFAULT 1;

        -- Vínculos de Sala na Grade de Horários
        ALTER TABLE teacher_schedules ADD COLUMN IF NOT EXISTS classroom_id INT REFERENCES classrooms(id) ON DELETE SET NULL;

        -- Registro de Sala e Recursos Utilizados no Diário de Classe
        ALTER TABLE class_logs ADD COLUMN IF NOT EXISTS classroom_id INT REFERENCES classrooms(id) ON DELETE SET NULL;
        ALTER TABLE class_logs ADD COLUMN IF NOT EXISTS resources_used JSONB DEFAULT '[]'::jsonb;

        -- ========================================================
        -- ESTRUTURAS DO PORTAL EDUCACIONAL & LMS
        -- ========================================================

        -- Cursos e Trilhas de Formação
        CREATE TABLE IF NOT EXISTS courses (
          id SERIAL PRIMARY KEY,
          code VARCHAR(50) UNIQUE NOT NULL,
          subject_id INT REFERENCES subjects(id) ON DELETE SET NULL,
          title VARCHAR(150) NOT NULL,
          headline VARCHAR(255),
          description TEXT,
          category VARCHAR(80) DEFAULT 'reforco', -- 'concurso', 'reforco', 'redacao', 'informatica'
          modality VARCHAR(40) DEFAULT 'hibrido', -- 'online', 'presencial', 'hibrido'
          price NUMERIC(10,2) DEFAULT 250.00,
          workload_hours INT DEFAULT 40,
          icon VARCHAR(50) DEFAULT '📚',
          badge VARCHAR(50) DEFAULT 'Matrículas Abertas',
          featured BOOLEAN DEFAULT true,
          status VARCHAR(20) DEFAULT 'ativo',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Módulos do Curso
        CREATE TABLE IF NOT EXISTS course_modules (
          id SERIAL PRIMARY KEY,
          course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          title VARCHAR(150) NOT NULL,
          description TEXT,
          order_index INT DEFAULT 1,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Aulas Online (Vídeos gravados ou Aulas ao vivo)
        CREATE TABLE IF NOT EXISTS course_lessons (
          id SERIAL PRIMARY KEY,
          module_id INT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
          title VARCHAR(150) NOT NULL,
          description TEXT,
          video_url VARCHAR(255),
          live_meeting_url VARCHAR(255),
          live_scheduled_at TIMESTAMP WITH TIME ZONE,
          duration_minutes INT DEFAULT 45,
          order_index INT DEFAULT 1,
          resources JSONB DEFAULT '[]'::jsonb,
          status VARCHAR(20) DEFAULT 'ativo',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Progresso do Aluno nas Aulas
        CREATE TABLE IF NOT EXISTS student_lesson_progress (
          student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          lesson_id INT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
          completed BOOLEAN DEFAULT false,
          completed_at TIMESTAMP WITH TIME ZONE,
          PRIMARY KEY (student_id, lesson_id)
        );

        -- Tarefas, Atividades e Redações
        CREATE TABLE IF NOT EXISTS student_assignments (
          id SERIAL PRIMARY KEY,
          course_id INT REFERENCES courses(id) ON DELETE SET NULL,
          lesson_id INT REFERENCES course_lessons(id) ON DELETE SET NULL,
          student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          teacher_id INT REFERENCES users(id) ON DELETE SET NULL,
          title VARCHAR(200) NOT NULL,
          instructions TEXT,
          due_date DATE,
          submission_text TEXT,
          attachment_url VARCHAR(255),
          teacher_feedback TEXT,
          grade NUMERIC(4,2),
          status VARCHAR(30) DEFAULT 'pendente', -- 'pendente', 'enviado', 'corrigido'
          submitted_at TIMESTAMP WITH TIME ZONE,
          graded_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- ========================================================
        -- ESTRUTURAS DO SISTEMA FINANCEIRO ESCOLAR
        -- ========================================================

        -- Planos de Mensalidade / Cobrança
        CREATE TABLE IF NOT EXISTS financial_plans (
          id SERIAL PRIMARY KEY,
          name VARCHAR(150) NOT NULL,
          description TEXT,
          amount NUMERIC(10,2) NOT NULL,
          due_day INT DEFAULT 10,
          frequency VARCHAR(40) DEFAULT 'mensal',
          status VARCHAR(20) DEFAULT 'ativo',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Faturas / Mensalidades
        CREATE TABLE IF NOT EXISTS invoices (
          id SERIAL PRIMARY KEY,
          invoice_number VARCHAR(50) UNIQUE,
          student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          plan_id INT REFERENCES financial_plans(id) ON DELETE SET NULL,
          title VARCHAR(200) NOT NULL,
          description TEXT,
          amount NUMERIC(10,2) NOT NULL,
          discount NUMERIC(10,2) DEFAULT 0.00,
          net_amount NUMERIC(10,2) NOT NULL,
          due_date DATE NOT NULL,
          paid_date DATE,
          payment_method VARCHAR(40) DEFAULT 'pix',
          pix_code TEXT,
          pix_qrcode_url TEXT,
          status VARCHAR(20) DEFAULT 'pendente', -- 'pendente', 'pago', 'atrasado', 'cancelado'
          receipt_number VARCHAR(50),
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- ========================================================
        -- CAPTAÇÃO DE ALUNOS (LEADS DO SITE INSTITUCIONAL)
        -- ========================================================
        CREATE TABLE IF NOT EXISTS leads_contacts (
          id SERIAL PRIMARY KEY,
          name VARCHAR(150) NOT NULL,
          phone VARCHAR(50) NOT NULL,
          email VARCHAR(150),
          course_interest VARCHAR(100),
          student_grade VARCHAR(100),
          message TEXT,
          status VARCHAR(30) DEFAULT 'novo', -- 'novo', 'contatado', 'agendado', 'matriculado', 'arquivado'
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Suporte a salas virtuais e links online na grade
        ALTER TABLE teacher_schedules ADD COLUMN IF NOT EXISTS live_meeting_url VARCHAR(255);
        ALTER TABLE classrooms ADD COLUMN IF NOT EXISTS live_meeting_url VARCHAR(255);

        -- Ajusta timezone da sessão para padrão São Paulo / Brasil
        SET timezone = 'America/Sao_Paulo';
      `);

      // Relatório de Acompanhamento Pedagógico (ficha preenchida pelo professor)
      await client.query(`
        CREATE TABLE IF NOT EXISTS pedagogical_reports (
          id SERIAL PRIMARY KEY,
          student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          teacher_id INT REFERENCES users(id) ON DELETE SET NULL,
          teacher_name VARCHAR(150),
          report_date DATE NOT NULL DEFAULT CURRENT_DATE,
          student_age VARCHAR(30),
          class_info VARCHAR(150),
          period_start DATE,
          period_end DATE,
          lessons_count INT,
          objectives JSONB NOT NULL DEFAULT '[]',
          objectives_other VARCHAR(200),
          academic_development TEXT,
          performance JSONB NOT NULL DEFAULT '{}',
          performance_other_label VARCHAR(100),
          academic_notes TEXT,
          behavior_overall VARCHAR(30),
          behavior_aspects JSONB NOT NULL DEFAULT '[]',
          behavior_notes TEXT,
          strategies JSONB NOT NULL DEFAULT '[]',
          strategies_other VARCHAR(200),
          evolution TEXT,
          emotional_behaviors JSONB NOT NULL DEFAULT '[]',
          emotional_other VARCHAR(200),
          emotional_notes TEXT,
          family_recommendations TEXT,
          school_suggestions TEXT,
          final_considerations TEXT,
          status VARCHAR(20) NOT NULL DEFAULT 'rascunho',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_pedagogical_reports_student ON pedagogical_reports(student_id, report_date DESC);
      `);

      // Mensagens da família (pais → professor ou coordenação) e respostas da equipe
      await client.query(`
        CREATE TABLE IF NOT EXISTS family_messages (
          id SERIAL PRIMARY KEY,
          student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          parent_user_id INT REFERENCES users(id) ON DELETE SET NULL,
          parent_name VARCHAR(150),
          recipient_type VARCHAR(20) NOT NULL,
          teacher_id INT REFERENCES users(id) ON DELETE SET NULL,
          body TEXT NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'nova',
          read_at TIMESTAMP WITH TIME ZONE,
          reply TEXT,
          reply_by INT REFERENCES users(id) ON DELETE SET NULL,
          reply_by_name VARCHAR(150),
          replied_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_family_messages_student ON family_messages(student_id, created_at DESC);
      `);

      // Controle de execução única dos povoamentos e migrações de dados.
      // Sem isso, cada reinício do servidor sobrescrevia edições feitas pelo admin.
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_meta (
          key VARCHAR(100) PRIMARY KEY,
          value TEXT,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const usersCount = await client.query('SELECT COUNT(*) FROM users');
      const isFreshInstall = parseInt(usersCount.rows[0].count) === 0;

      // Povoamentos de demonstração: só rodam numa instalação nova, e uma única vez
      // Dados de demonstração só entram com SEED_DEMO=true (ambiente de teste). Em produção, o banco nasce vazio.
      const DEMO = process.env.SEED_DEMO === 'true';
      const seedOnce = async (key, fn) => {
        const done = await client.query('SELECT 1 FROM app_meta WHERE key = $1', [key]);
        if (done.rows.length > 0) return;
        if (isFreshInstall && DEMO) await fn();
        await client.query(
          'INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
          [key, isFreshInstall ? 'executado' : 'ignorado (banco já existente)']
        );
      };

      if (typeof seedDataFn === 'function') await seedOnce('seed_planilha_inicial', () => seedDataFn());

      // Primeiro acesso em produção: cria o administrador com ADMIN_EMAIL / ADMIN_PASSWORD (variáveis de ambiente)
      if (isFreshInstall && !DEMO && process.env.ADMIN_PASSWORD) {
        const { hash, salt } = hashPassword(process.env.ADMIN_PASSWORD);
        await client.query(`
          INSERT INTO users (name, email, password_hash, salt, role, status)
          VALUES ('Administrador', $1, $2, $3, 'admin', 'ativo')
          ON CONFLICT (email) DO NOTHING
        `, [(process.env.ADMIN_EMAIL || 'admin@entrelinhas.com').trim().toLowerCase(), hash, salt]);
        console.log(' Administrador inicial criado a partir das variáveis de ambiente.');
      }
      await seedOnce('seed_salas', () => seedClassrooms(client));
      await seedOnce('seed_usuarios', () => seedUsers(client));
      await seedOnce('seed_grade_horarios', () => seedSchedules(client));
      await seedOnce('seed_familias_agenda', () => seedParentAccessAndAgenda(client));
      await seedOnce('seed_matriculas_vinculos', () => seedEnrollmentsAndBindings(client));
      await seedOnce('seed_portal_educacional', () => seedEducationalPortalData(client));

      // Migrações de consistência: rodam uma vez em qualquer banco (novo ou existente)
      const migrationKey = 'migracao_consistencia_2026_10';
      const migDone = await client.query('SELECT 1 FROM app_meta WHERE key = $1', [migrationKey]);
      if (migDone.rows.length === 0) {
        await runConsistencyMigration(client);
        await client.query('INSERT INTO app_meta (key, value) VALUES ($1, $2)', [migrationKey, 'executado']);
      }

      client.release();
      console.log(' Tabelas e estruturas atualizadas com sucesso!');
      return;
    } catch (err) {
      retries--;
      console.log(` Tentando conectar ao PostgreSQL... Restam ${retries} tentativas. (${err.message})`);
      await new Promise(res => setTimeout(res, 3000));
    }
  }
  throw new Error('Não foi possível conectar ao banco de dados após várias tentativas.');
}

async function seedUsers(client) {
  const countRes = await client.query('SELECT COUNT(*) FROM users');
  if (parseInt(countRes.rows[0].count) > 0) return;

  console.log(' Povoando usuários e professores padrão...');
  const usersToSeed = [
    {
      name: 'Administrador Entrelinhas',
      email: 'admin@entrelinhas.com',
      password: 'admin123',
      role: 'admin',
      subjectCodes: []
    },
    {
      name: 'Luciano',
      email: 'luciano@entrelinhas.com',
      password: 'prof123',
      role: 'professor',
      subjectCodes: ['port_concurso', 'portugues_reforco', 'redacao']
    },
    {
      name: 'Sibele',
      email: 'sibele@entrelinhas.com',
      password: 'prof123',
      role: 'professor',
      subjectCodes: ['matematica_reforco']
    },
    {
      name: 'Fernando',
      email: 'fernando@entrelinhas.com',
      password: 'prof123',
      role: 'professor',
      subjectCodes: ['informatica']
    }
  ];

  for (const u of usersToSeed) {
    const { hash, salt } = hashPassword(u.password);
    const res = await client.query(`
      INSERT INTO users (name, email, password_hash, salt, role, status)
      VALUES ($1, $2, $3, $4, $5, 'ativo')
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `, [u.name, u.email, hash, salt, u.role]);

    if (res.rows.length > 0) {
      const userId = res.rows[0].id;
      for (const code of u.subjectCodes) {
        await client.query(`
          INSERT INTO teacher_subjects (user_id, subject_id)
          SELECT $1, s.id FROM subjects s WHERE s.code = $2
          ON CONFLICT DO NOTHING
        `, [userId, code]);
      }
      // Vincula logs históricos de aula ao professor
      if (u.role === 'professor') {
        await client.query(`
          UPDATE class_logs SET teacher_id = $1 WHERE teacher_name ILIKE $2 AND teacher_id IS NULL
        `, [userId, `%${u.name}%`]);
      }
    }
  }
  console.log(' Usuários e professores padrão criados com sucesso!');
}

async function seedSchedules(client) {
  const countRes = await client.query('SELECT COUNT(*) FROM teacher_schedules');
  if (parseInt(countRes.rows[0].count) > 0) return;

  console.log(' Povoando grade de horários padrão dos professores...');
  const schedulesToSeed = [
    // Prof. Luciano (Português / Redação)
    {
      teacherEmail: 'luciano@entrelinhas.com',
      subjectCode: 'port_concurso',
      dayOfWeek: 1, // Segunda
      startTime: '08:00',
      endTime: '09:30',
      room: 'Sala 01 - Presencial',
      notes: 'Turma foco em gramática e interpretação'
    },
    {
      teacherEmail: 'luciano@entrelinhas.com',
      subjectCode: 'redacao',
      dayOfWeek: 1, // Segunda
      startTime: '14:00',
      endTime: '15:30',
      room: 'Sala 02 - Presencial',
      notes: 'Oficina de produção textual dissertativa'
    },
    {
      teacherEmail: 'luciano@entrelinhas.com',
      subjectCode: 'portugues_reforco',
      dayOfWeek: 3, // Quarta
      startTime: '08:00',
      endTime: '09:30',
      room: 'Sala 01 - Presencial',
      notes: 'Reforço escolar individual e em pequenos grupos'
    },
    {
      teacherEmail: 'luciano@entrelinhas.com',
      subjectCode: 'redacao',
      dayOfWeek: 3, // Quarta
      startTime: '14:00',
      endTime: '15:30',
      room: 'Sala 02 - Presencial',
      notes: 'Revisão e reescrita de redações'
    },

    // Profa. Sibele (Matemática Reforço)
    {
      teacherEmail: 'sibele@entrelinhas.com',
      subjectCode: 'matematica_reforco',
      dayOfWeek: 2, // Terça
      startTime: '09:30',
      endTime: '11:00',
      room: 'Sala 03 - Presencial',
      notes: 'Fundamentos de álgebra e frações'
    },
    {
      teacherEmail: 'sibele@entrelinhas.com',
      subjectCode: 'matematica_reforco',
      dayOfWeek: 2, // Terça
      startTime: '15:30',
      endTime: '17:00',
      room: 'Sala 03 - Presencial',
      notes: 'Resolução de exercícios e preparação para provas'
    },
    {
      teacherEmail: 'sibele@entrelinhas.com',
      subjectCode: 'matematica_reforco',
      dayOfWeek: 4, // Quinta
      startTime: '09:30',
      endTime: '11:00',
      room: 'Sala 03 - Presencial',
      notes: 'Geometria básica e raciocínio lógico'
    },
    {
      teacherEmail: 'sibele@entrelinhas.com',
      subjectCode: 'matematica_reforco',
      dayOfWeek: 4, // Quinta
      startTime: '15:30',
      endTime: '17:00',
      room: 'Sala 03 - Presencial',
      notes: 'Plantão de dúvidas individual'
    },

    // Prof. Fernando (Informática)
    {
      teacherEmail: 'fernando@entrelinhas.com',
      subjectCode: 'informatica',
      dayOfWeek: 1, // Segunda
      startTime: '10:00',
      endTime: '11:30',
      room: 'Laboratório de Informática',
      notes: 'Pacote Office e digitação'
    },
    {
      teacherEmail: 'fernando@entrelinhas.com',
      subjectCode: 'informatica',
      dayOfWeek: 3, // Quarta
      startTime: '16:00',
      endTime: '17:30',
      room: 'Laboratório de Informática',
      notes: 'Lógica e ferramentas digitais'
    },
    {
      teacherEmail: 'fernando@entrelinhas.com',
      subjectCode: 'informatica',
      dayOfWeek: 5, // Sexta
      startTime: '10:00',
      endTime: '11:30',
      room: 'Laboratório de Informática',
      notes: 'Projetos práticos e navegação segura'
    }
  ];

  for (const s of schedulesToSeed) {
    await client.query(`
      INSERT INTO teacher_schedules (teacher_id, subject_id, day_of_week, start_time, end_time, room_or_info, notes, status)
      SELECT u.id, sub.id, $1, $2, $3, $4, $5, 'ativo'
      FROM users u, subjects sub
      WHERE u.email = $6 AND sub.code = $7
      ON CONFLICT DO NOTHING
    `, [s.dayOfWeek, s.startTime, s.endTime, s.room, s.notes, s.teacherEmail, s.subjectCode]);
  }
  console.log(' Grade de horários padrão configurada com sucesso!');
}

async function seedParentAccessAndAgenda(client) {
  try {
    // 1. Garante que todos os alunos tenham código de acesso para os pais
    await client.query(`
      UPDATE students 
      SET parent_access_code = 'PAIS-' || id 
      WHERE parent_access_code IS NULL OR parent_access_code = '';
    `);

    // Dados customizados e amigáveis para os principais alunos
    await client.query(`
      UPDATE students 
      SET parent_name = 'Mariana Sousa',
          parent_email = 'pais.anaclara@entrelinhas.online',
          parent_phone = '(47) 99881-2233',
          parent_access_code = 'PAIS-ANA'
      WHERE LOWER(name) LIKE '%ana clara%';

      UPDATE students 
      SET parent_name = 'Carlos Eduardo Iurk',
          parent_email = 'pais.davi@entrelinhas.online',
          parent_phone = '(47) 99772-1144',
          parent_access_code = 'PAIS-DAVI'
      WHERE LOWER(name) LIKE '%davi matias%';

      UPDATE students 
      SET parent_name = 'Lucia de Jesus',
          parent_email = 'pais.nycolas@entrelinhas.online',
          parent_phone = '(47) 99123-4567',
          parent_access_code = 'PAIS-NYCOLAS'
      WHERE LOWER(name) LIKE '%nycolas%';
    `);

    // 2. Cria contas para os pais se não existirem
    const parentsToSeed = [
      { name: 'Mariana Sousa (Mãe Ana Clara)', email: 'pais.anaclara@entrelinhas.online', pass: 'pais123', studentSearch: '%ana clara%' },
      { name: 'Carlos Eduardo Iurk (Pai Davi)', email: 'pais.davi@entrelinhas.online', pass: 'pais123', studentSearch: '%davi matias%' },
      { name: 'Lucia de Jesus (Mãe Nycolas)', email: 'pais.nycolas@entrelinhas.online', pass: 'pais123', studentSearch: '%nycolas%' }
    ];

    for (const p of parentsToSeed) {
      const stRes = await client.query('SELECT id FROM students WHERE LOWER(name) LIKE $1 LIMIT 1', [p.studentSearch]);
      if (stRes.rows.length > 0) {
        const studentId = stRes.rows[0].id;
        const { hash, salt } = hashPassword(p.pass);
        await client.query(`
          INSERT INTO users (name, email, password_hash, salt, role, status, student_id)
          VALUES ($1, $2, $3, $4, 'responsavel', 'ativo', $5)
          ON CONFLICT (email) DO UPDATE SET student_id = $5, role = 'responsavel'
        `, [p.name, p.email, hash, salt, studentId]);
      }
    }

    // 3. Seed de mensagens na agenda
    const agendaCount = await client.query('SELECT COUNT(*) FROM student_agenda');
    if (parseInt(agendaCount.rows[0].count) === 0) {
      console.log(' Povoando recados e avisos padrão na agenda dos alunos...');
      
      const stList = await client.query(`SELECT id, name FROM students WHERE LOWER(name) LIKE '%ana clara%' OR LOWER(name) LIKE '%davi matias%' OR LOWER(name) LIKE '%nycolas%'`);

      for (const st of stList.rows) {
        // Recado 1: Boas-vindas
        await client.query(`
          INSERT INTO student_agenda 
            (student_id, author_name, entry_date, entry_time, category, title, content, is_important, read_by_parent)
          VALUES 
            ($1, 'Coordenação Entrelinhas', CURRENT_DATE - INTERVAL '3 days', '08:00', 'aviso', 
             'Boas-vindas ao Portal da Família Entrelinhas! ✨', 
             'Olá família! Agora vocês podem acompanhar por aqui a agenda semanal, tarefas, recados pedagógicos e o horário das aulas de ' || $2 || '. Sejam muito bem-vindos!', 
             true, true)
        `, [st.id, st.name]);

        // Recado 2: Elogio de desenvolvimento
        await client.query(`
          INSERT INTO student_agenda 
            (student_id, author_name, entry_date, entry_time, category, title, content, is_important, read_by_parent)
          VALUES 
            ($1, 'Prof. Luciano', CURRENT_DATE - INTERVAL '1 day', '10:30', 'elogio', 
             'Parabéns pela dedicação e foco na aula de hoje! ⭐', 
             'Queremos destacar o excelente progresso de ' || $2 || ' nas atividades desta semana. Participação ativa e dedicação exemplar nos exercícios propostos.', 
             false, false)
        `, [st.id, st.name]);

        // Recado 3: Tarefa de fixação
        await client.query(`
          INSERT INTO student_agenda 
            (student_id, author_name, entry_date, entry_time, category, title, content, is_important, read_by_parent)
          VALUES 
            ($1, 'Professora', CURRENT_DATE, '14:00', 'tarefa', 
             'Leitura e Atividade Prática de Fixação 📚', 
             'Recomendamos a prática dos exercícios complementares da página 12 a 15 até a próxima aula. Em caso de dúvidas, nossa equipe pedagógica está sempre à disposição.', 
             false, false)
        `, [st.id]);
      }
      console.log(' Agenda dos alunos povoada com sucesso!');
    }
  } catch (err) {
    console.error('Erro ao semear dados de pais e agenda:', err);
  }
}

async function seedEnrollmentsAndBindings(client) {
  try {
    // 1. Atualiza alunos existentes com dados de matrícula e frequência
    await client.query(`
      -- Davi Matias -> Semanal, Luciano
      UPDATE students 
      SET frequency_type = 'semanal',
          preferred_days = '1',
          preferred_time = '08:00',
          duration_minutes = 90,
          enrollment_status = 'ativo',
          assigned_teacher_id = (SELECT id FROM users WHERE email = 'luciano@entrelinhas.com' LIMIT 1)
      WHERE LOWER(name) LIKE '%davi matias%';

      -- Ana Clara -> Quinzenal, Sibele
      UPDATE students 
      SET frequency_type = 'quinzenal',
          preferred_days = '3',
          preferred_time = '14:00',
          duration_minutes = 90,
          enrollment_status = 'ativo',
          assigned_teacher_id = (SELECT id FROM users WHERE email = 'sibele@entrelinhas.com' LIMIT 1)
      WHERE LOWER(name) LIKE '%ana clara%';

      -- Nycolas -> Personalizada a cada 3 dias, Fernando
      UPDATE students 
      SET frequency_type = 'custom_dias',
          custom_interval_days = 3,
          preferred_days = '1,3,5',
          preferred_time = '10:00',
          duration_minutes = 90,
          enrollment_status = 'ativo',
          assigned_teacher_id = (SELECT id FROM users WHERE email = 'fernando@entrelinhas.com' LIMIT 1)
      WHERE LOWER(name) LIKE '%nycolas%';
    `);

    // 2. Cria ou atualiza alunos em status "aguardando_professor" para teste de amarração!
    const pendingStudents = [
      {
        name: 'Sabrina Cristina Dognini',
        grade: 'Concurso Público - Redação & Gramática',
        freq: 'semanal',
        interval: 7,
        days: '2',
        time: '14:00',
        duration: 90,
        notes: 'Aluno solicitou foco em dissertação argumentativa para edital PM-SC.'
      },
      {
        name: 'Letícia de Souza',
        grade: 'Reforço Escolar - Matemática 9º Ano',
        freq: 'quinzenal',
        interval: 14,
        days: '4',
        time: '15:30',
        duration: 60,
        notes: 'Necessita reforço a cada 15 dias para resolução de exercícios de álgebra.'
      },
      {
        name: 'Arthur Gabriel Santos',
        grade: 'Informática Básica e Ferramentas Digitais',
        freq: 'custom_dias',
        interval: 4,
        days: '1,5',
        time: '16:00',
        duration: 60,
        notes: 'Frequência intensiva a cada 4 dias.'
      }
    ];

    for (const p of pendingStudents) {
      const exists = await client.query('SELECT id FROM students WHERE LOWER(name) = LOWER($1)', [p.name]);
      if (exists.rows.length === 0) {
        const ins = await client.query(`
          INSERT INTO students 
            (name, objective_grade, start_date, status, frequency_type, custom_interval_days, preferred_days, preferred_time, duration_minutes, enrollment_status, enrollment_notes)
          VALUES 
            ($1, $2, '01/10/2026', 'ativo', $3, $4, $5, $6, $7, 'aguardando_professor', $8)
          RETURNING id
        `, [p.name, p.grade, p.freq, p.interval, p.days, p.time, p.duration, p.notes]);

        if (p.name.includes('Sabrina')) {
          await client.query(`INSERT INTO student_subjects (student_id, subject_id) SELECT $1, id FROM subjects WHERE code = 'port_concurso' ON CONFLICT DO NOTHING`, [ins.rows[0].id]);
        } else if (p.name.includes('Letícia')) {
          await client.query(`INSERT INTO student_subjects (student_id, subject_id) SELECT $1, id FROM subjects WHERE code = 'matematica_reforco' ON CONFLICT DO NOTHING`, [ins.rows[0].id]);
        } else if (p.name.includes('Arthur')) {
          await client.query(`INSERT INTO student_subjects (student_id, subject_id) SELECT $1, id FROM subjects WHERE code = 'informatica' ON CONFLICT DO NOTHING`, [ins.rows[0].id]);
        }
      } else {
        await client.query(`
          UPDATE students 
          SET frequency_type = COALESCE(frequency_type, $2),
              custom_interval_days = COALESCE(custom_interval_days, $3),
              preferred_days = COALESCE(preferred_days, $4),
              preferred_time = COALESCE(preferred_time, $5),
              duration_minutes = COALESCE(duration_minutes, $6),
              enrollment_notes = COALESCE(enrollment_notes, $7),
              enrollment_status = CASE WHEN assigned_teacher_id IS NULL THEN 'aguardando_professor' ELSE enrollment_status END
          WHERE id = $1
        `, [exists.rows[0].id, p.freq, p.interval, p.days, p.time, p.duration, p.notes]);
      }
    }

    // 3. Vincula os student_id nos teacher_schedules existentes para aparecerem com nomes de alunos na grade!
    await client.query(`
      UPDATE teacher_schedules ts
      SET student_id = (SELECT id FROM students WHERE LOWER(name) LIKE '%davi matias%' LIMIT 1),
          frequency_type = 'semanal'
      WHERE ts.start_time = '08:00' AND ts.day_of_week = 1 AND ts.student_id IS NULL;

      UPDATE teacher_schedules ts
      SET student_id = (SELECT id FROM students WHERE LOWER(name) LIKE '%ana clara%' LIMIT 1),
          frequency_type = 'quinzenal'
      WHERE ts.day_of_week = 3 AND ts.student_id IS NULL;

      UPDATE teacher_schedules ts
      SET student_id = (SELECT id FROM students WHERE LOWER(name) LIKE '%nycolas%' LIMIT 1),
          frequency_type = 'custom_dias',
          recurrence_interval_days = 3
      WHERE ts.start_time = '10:00' AND ts.student_id IS NULL;
    `);

    console.log(' Matrículas, frequências e amarração de professores configuradas com sucesso!');
  } catch (err) {
    console.error('Erro ao semear matrículas e frequências:', err);
  }
}

async function seedClassrooms(client) {
  try {
    const countRes = await client.query('SELECT COUNT(*) FROM classrooms');
    if (parseInt(countRes.rows[0].count) > 0) return;

    console.log(' Povoando salas e recursos pedagógicos padrão...');
    const resSala1 = await client.query(`
      INSERT INTO classrooms (name, type, capacity_students, capacity_teachers, resources, description, status)
      VALUES (
        'Sala 01 - Presencial (Principal)',
        'presencial',
        4,
        1,
        $1::jsonb,
        'Sala física climatizada com 4 carteiras, lousa digital, projetor e bancada com 2 computadores para informática.',
        'ativo'
      ) RETURNING id
    `, [JSON.stringify([
      'Computadores',
      'Projetor',
      'Lousa Digital',
      'Jogos Pedagógicos',
      'Armário de Apoio',
      'Carteiras Individuais'
    ])]);

    const sala1Id = resSala1.rows[0].id;

    await client.query(`
      INSERT INTO classrooms (name, type, capacity_students, capacity_teachers, resources, description, status)
      VALUES (
        'Ambiente Virtual (Online)',
        'online',
        99,
        99,
        $1::jsonb,
        'Ambiente online flexível para aulas remotas com videoconferência síncrona via Google Meet e salas simultâneas.',
        'ativo'
      )
    `, [JSON.stringify([
      'Google Meet / Sala Virtual',
      'Lousa Virtual Compartilhada'
    ])]);

    // Vincula as matérias padrão à Sala 01 e define limites
    await client.query(`
      UPDATE subjects 
      SET classroom_id = $1, 
          max_students = 4, 
          required_resources = '["Lousa Digital", "Jogos Pedagógicos"]'::jsonb
      WHERE code IN ('port_concurso', 'portugues_reforco', 'redacao', 'matematica_reforco')
    `, [sala1Id]);

    await client.query(`
      UPDATE subjects 
      SET classroom_id = $1, 
          max_students = 2, 
          required_resources = '["Computadores"]'::jsonb
      WHERE code = 'informatica'
    `, [sala1Id]);

    await client.query(`
      UPDATE teacher_schedules 
      SET classroom_id = $1
      WHERE classroom_id IS NULL
    `, [sala1Id]);

    console.log(' Salas e recursos configurados com sucesso!');
  } catch (err) {
    console.error('Erro ao semear salas:', err);
  }
}

async function seedEducationalPortalData(client) {
  try {
    // 1. Cursos, Módulos e Aulas Online
    const coursesCount = await client.query('SELECT COUNT(*) FROM courses');
    if (parseInt(coursesCount.rows[0].count) === 0) {
      console.log(' Povoando Cursos, Módulos e Aulas Online...');

      // Curso 1: Português para Concursos
      const resC1 = await client.query(`
        INSERT INTO courses 
          (code, subject_id, title, headline, description, category, modality, price, workload_hours, icon, badge, featured)
        VALUES 
          ('concurso_port', 
           (SELECT id FROM subjects WHERE code = 'port_concurso' LIMIT 1),
           'Português para Concursos Públicos & Carreiras',
           'Domine gramática aplicada, interpretação de texto e bancas examinadoras.',
           'Curso preparatório completo com foco em resolução de questões, bancas FGV, Cespe/Cebraspe, FCC e bancas regionais. Aulas teóricas e práticas com acompanhamento semanal do Prof. Luciano.',
           'concurso', 'hibrido', 380.00, 60, '🎯', 'Mais Procurado', true)
        RETURNING id
      `);
      const c1Id = resC1.rows[0].id;

      const resM1_1 = await client.query(`
        INSERT INTO course_modules (course_id, title, description, order_index)
        VALUES ($1, 'Módulo 1: Sintaxe da Oração e do Período', 'Fundamentos de análise sintática e termos da oração essenciais para gabaritar bancas.', 1)
        RETURNING id
      `, [c1Id]);
      const m1_1Id = resM1_1.rows[0].id;

      await client.query(`
        INSERT INTO course_lessons 
          (module_id, title, description, video_url, live_meeting_url, duration_minutes, order_index, resources)
        VALUES 
          ($1, 'Aula 1: Termos Essenciais e Integrantes da Oração', 
           'Sujeito, predicado, complementos verbais e nominais explicados com resolução de questões comentadas.', 
           'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://meet.google.com/ent-port-conc', 50, 1, 
           $2::jsonb),
          ($1, 'Aula 2: Concordância Verbal e Nominal sem Segredos', 
           'Regras gerais e casos especiais mais cobrados pela FGV e Cebraspe.', 
           'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://meet.google.com/ent-port-conc', 45, 2, 
           $3::jsonb),
          ($1, 'Aula 3: Regência e o Uso Prático da Crase', 
           'Casos proibitivos, facultativos e obrigatórios com macetes mnemônicos testados.', 
           'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://meet.google.com/ent-port-conc', 55, 3, 
           $4::jsonb)
      `, [
        m1_1Id,
        JSON.stringify([{ title: 'Apostila Teórica - Sintaxe Essencial (PDF)', url: 'https://exemplo.com/apostila-sintaxe.pdf', size: '2.4 MB' }]),
        JSON.stringify([{ title: 'Lista de 30 Questões FGV Gabaritadas (PDF)', url: 'https://exemplo.com/questoes-concordancia.pdf', size: '1.1 MB' }]),
        JSON.stringify([{ title: 'Mapa Mental: Casos de Crase (PDF)', url: 'https://exemplo.com/mapa-crase.pdf', size: '850 KB' }])
      ]);

      const resM1_2 = await client.query(`
        INSERT INTO course_modules (course_id, title, description, order_index)
        VALUES ($1, 'Módulo 2: Interpretação, Coesão e Coerência', 'Estratégias de leitura dinâmica e decodificação dos enunciados capciosos.', 2)
        RETURNING id
      `, [c1Id]);
      const m1_2Id = resM1_2.rows[0].id;

      await client.query(`
        INSERT INTO course_lessons 
          (module_id, title, description, video_url, live_meeting_url, duration_minutes, order_index, resources)
        VALUES 
          ($1, 'Aula 4: Gêneros Textuais e Ambiguidade nas Provas', 
           'Como identificar a intenção comunicativa do autor e evitar pegadinhas de distratores.', 
           'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://meet.google.com/ent-port-conc', 40, 1, '[]'::jsonb),
          ($1, 'Aula 5: Plantão Ao Vivo de Resolução de Simulado', 
           'Sessão interativa síncrona com Prof. Luciano corrigindo o Simulado 01 ao vivo com a turma.', 
           NULL, 'https://meet.google.com/ent-port-conc', 60, 2, '[]'::jsonb)
      `, [m1_2Id]);

      // Curso 2: Oficina de Redação Nota 1000
      const resC2 = await client.query(`
        INSERT INTO courses 
          (code, subject_id, title, headline, description, category, modality, price, workload_hours, icon, badge, featured)
        VALUES 
          ('redacao_elite', 
           (SELECT id FROM subjects WHERE code = 'redacao' LIMIT 1),
           'Oficina de Redação Nota 1000 & Produção Textual',
           'Estruture redações nota máxima para vestibulares, ENEM e editais militares.',
           'Treinamento intensivo de escrita dissertativo-argumentativa com propostas semanais, correção individual linha por linha e repertório sociocultural legitimado.',
           'redacao', 'hibrido', 290.00, 45, '✍️', 'Destaque', true)
        RETURNING id
      `);
      const c2Id = resC2.rows[0].id;

      const resM2_1 = await client.query(`
        INSERT INTO course_modules (course_id, title, description, order_index)
        VALUES ($1, 'Módulo 1: Estrutura Perfeita da Dissertação', 'Construção da introdução, argumentos com dados e conclusão conclusiva.', 1)
        RETURNING id
      `, [c2Id]);
      const m2_1Id = resM2_1.rows[0].id;

      await client.query(`
        INSERT INTO course_lessons 
          (module_id, title, description, video_url, live_meeting_url, duration_minutes, order_index, resources)
        VALUES 
          ($1, 'Aula 1: A Introdução Irretocável e a Tese Incontestável', 
           'Como prender a atenção do corretor nos primeiros 3 segundos de leitura com contextualização histórica ou filosófica.', 
           'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://meet.google.com/ent-redacao-live', 50, 1, 
           $2::jsonb),
          ($1, 'Aula 2: Desenvolvimento Argumentativo & Repertório Legitimado', 
           'Como usar sociologia, dados estatísticos e citações sem parecer forçado.', 
           'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://meet.google.com/ent-redacao-live', 45, 2, 
           $3::jsonb)
      `, [
        m2_1Id,
        JSON.stringify([{ title: 'Guia de Conectivos & Coesão Interparágrafos (PDF)', url: 'https://exemplo.com/guia-conectivos.pdf', size: '1.5 MB' }]),
        JSON.stringify([{ title: 'Banco de 50 Repertórios Coringa para Redação (PDF)', url: 'https://exemplo.com/repertorio-redacao.pdf', size: '3.2 MB' }])
      ]);

      // Curso 3: Reforço Escolar de Matemática
      const resC3 = await client.query(`
        INSERT INTO courses 
          (code, subject_id, title, headline, description, category, modality, price, workload_hours, icon, badge, featured)
        VALUES 
          ('mat_reforco', 
           (SELECT id FROM subjects WHERE code = 'matematica_reforco' LIMIT 1),
           'Reforço Escolar de Matemática (Fundamental & Médio)',
           'Recupere notas, supere bloqueios e desenvolva raciocínio lógico ágil.',
           'Acompanhamento pedagógico personalizado com a Profa. Sibele. Diagnóstico individual de dificuldades, plantão tira-dúvidas e preparação para provas bimestrais.',
           'reforco', 'presencial', 350.00, 50, '📐', 'Turmas Reduzidas', true)
        RETURNING id
      `);
      const c3Id = resC3.rows[0].id;

      const resM3_1 = await client.query(`
        INSERT INTO course_modules (course_id, title, description, order_index)
        VALUES ($1, 'Módulo 1: Fundamentos e Raciocínio Algébrico', 'Frações, operações fundamentais e equações de 1º e 2º grau.', 1)
        RETURNING id
      `, [c3Id]);
      const m3_1Id = resM3_1.rows[0].id;

      await client.query(`
        INSERT INTO course_lessons 
          (module_id, title, description, video_url, live_meeting_url, duration_minutes, order_index, resources)
        VALUES 
          ($1, 'Aula 1: Frações, Decimais e Porcentagem na Prática', 
           'Compreensão visual e intuitiva de frações sem decoreba de fórmulas.', 
           'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://meet.google.com/ent-mat-live', 60, 1, 
           $2::jsonb),
          ($1, 'Aula 2: Equações e Problemas Contextualizados', 
           'Como interpretar o enunciado e transformá-lo em uma equação matemática.', 
           'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://meet.google.com/ent-mat-live', 50, 2, 
           $3::jsonb)
      `, [
        m3_1Id,
        JSON.stringify([{ title: 'Caderno de Exercícios: Frações & Porcentagem (PDF)', url: 'https://exemplo.com/exercicios-fracoes.pdf', size: '1.8 MB' }]),
        JSON.stringify([{ title: 'Gabarito Passo a Passo de Equações (PDF)', url: 'https://exemplo.com/gabarito-equacoes.pdf', size: '920 KB' }])
      ]);

      // Curso 4: Informática Prática
      await client.query(`
        INSERT INTO courses 
          (code, subject_id, title, headline, description, category, modality, price, workload_hours, icon, badge, featured)
        VALUES 
          ('info_pratica', 
           (SELECT id FROM subjects WHERE code = 'informatica' LIMIT 1),
           'Informática Prática, Digitação & Ferramentas Digitais',
           'Do básico ao produtivo: Pacote Office, planilhas inteligentes e navegação segura.',
           'Ideal para jovens e adultos que buscam autonomia tecnológica no mercado de trabalho ou no ambiente acadêmico com a Prof. Fernando.',
           'informatica', 'presencial', 260.00, 35, '💻', 'Certificado Incluso', true)
      `);

      console.log(' Cursos e Aulas Online cadastrados com sucesso!');
    }

    // 2. Tarefas e Redações (student_assignments)
    const assignCount = await client.query('SELECT COUNT(*) FROM student_assignments');
    if (parseInt(assignCount.rows[0].count) === 0) {
      console.log(' Povoando tarefas e redações de exemplo...');
      const daviRes = await client.query(`SELECT id FROM students WHERE LOWER(name) LIKE '%davi matias%' LIMIT 1`);
      const sabrinaRes = await client.query(`SELECT id FROM students WHERE LOWER(name) LIKE '%sabrina%' LIMIT 1`);
      const lucianoRes = await client.query(`SELECT id FROM users WHERE email = 'luciano@entrelinhas.com' LIMIT 1`);

      if (daviRes.rows.length > 0 && lucianoRes.rows.length > 0) {
        await client.query(`
          INSERT INTO student_assignments 
            (student_id, teacher_id, title, instructions, due_date, submission_text, teacher_feedback, grade, status, submitted_at, graded_at)
          VALUES 
            ($1, $2, 'Redação 01: O impacto da Inteligência Artificial no mundo do trabalho',
             'Redigir texto dissertativo-argumentativo entre 20 e 30 linhas com proposta de intervenção completa.',
             CURRENT_DATE + INTERVAL '5 days',
             'A contemporaneidade vivencia uma acelerada transformação tecnológica impulsionada pela inteligência artificial. Conforme o sociólogo Zygmunt Bauman elucida na modernidade líquida...',
             'Excelente introdução e sustentação da tese com Bauman! Parabenizo pela contextualização e uso correto dos conectivos. Na conclusão, detalhe um pouco mais o agente executor da proposta.',
             9.40, 'corrigido', CURRENT_DATE - INTERVAL '2 days', CURRENT_DATE - INTERVAL '1 day')
        `, [daviRes.rows[0].id, lucianoRes.rows[0].id]);
      }

      if (sabrinaRes.rows.length > 0 && lucianoRes.rows.length > 0) {
        await client.query(`
          INSERT INTO student_assignments 
            (student_id, teacher_id, title, instructions, due_date, submission_text, status, submitted_at)
          VALUES 
            ($1, $2, 'Simulado FGV: 20 Questões de Sintaxe e Crase',
             'Resolver as 20 questões do simulado anexo e justificar as alternativas assinaladas.',
             CURRENT_DATE + INTERVAL '3 days',
             'Simulado resolvido. Fiquei em dúvida especificamente na questão 14 sobre crase antes de pronomes de tratamento.',
             'enviado', CURRENT_DATE)
        `, [sabrinaRes.rows[0].id, lucianoRes.rows[0].id]);
      }
    }

    // 3. Planos Financeiros (financial_plans)
    const plansCount = await client.query('SELECT COUNT(*) FROM financial_plans');
    if (parseInt(plansCount.rows[0].count) === 0) {
      console.log(' Povoando Planos Financeiros...');
      await client.query(`
        INSERT INTO financial_plans (name, description, amount, due_day, frequency)
        VALUES 
          ('Reforço Semanal Individualizado (1x/semana)', '4 aulas mensais individuais de 90 minutos com material didático e acompanhamento.', 350.00, 10, 'mensal'),
          ('Concurso & Redação Intensivo (2x/semana)', '8 encontros mensais com simulados corrigidos e acompanhamento individual.', 480.00, 10, 'mensal'),
          ('Oficina de Redação Nota 1000', '4 propostas mensais com correção linha a linha e atendimento pedagógico.', 290.00, 10, 'mensal'),
          ('Informática & Autonomia Digital', '4 aulas práticas semanais em laboratório climatizado com micro individual.', 260.00, 15, 'mensal')
      `);
    }

    // 4. Faturas / Mensalidades (invoices)
    const invoicesCount = await client.query('SELECT COUNT(*) FROM invoices');
    if (parseInt(invoicesCount.rows[0].count) === 0) {
      console.log(' Povoando Faturas e Mensalidades dos alunos...');

      const studentsList = await client.query(`SELECT id, name FROM students WHERE status = 'ativo' ORDER BY id ASC LIMIT 5`);

      let invoiceSeq = 100;
      for (const st of studentsList.rows) {
        invoiceSeq++;
        const isAna = st.name.toLowerCase().includes('ana');
        const isDavi = st.name.toLowerCase().includes('davi');
        const isNycolas = st.name.toLowerCase().includes('nycolas');

        const amount = isDavi ? 380.00 : (isAna ? 350.00 : (isNycolas ? 260.00 : 350.00));
        const courseName = isDavi ? 'Português & Redação' : (isAna ? 'Matemática Reforço' : (isNycolas ? 'Informática' : 'Ensino Regular'));

        // Fatura do Mês Passado (Paga)
        const pastNumber = `FAT-202609-${invoiceSeq}`;
        const pixPayloadPast = `00020126580014br.gov.bcb.pix0136comercial@entrelinhas.online520400005303986540${amount.toFixed(2)}5802BR5925ESCOLA ENTRELINHAS LTDA6008CAMBORIU62070503***6304ABCD`;
        
        await client.query(`
          INSERT INTO invoices 
            (invoice_number, student_id, title, description, amount, discount, net_amount, due_date, paid_date, payment_method, pix_code, status, receipt_number, notes)
          VALUES 
            ($1, $2, $3, $4, $5, 0.00, $5, CURRENT_DATE - INTERVAL '25 days', CURRENT_DATE - INTERVAL '24 days', 'pix', $6, 'pago', $7, 'Pagamento confirmado via Pix Instantâneo.')
        `, [
          pastNumber,
          st.id,
          `Mensalidade Setembro/2026 - ${courseName}`,
          `Cobrança referente às aulas ministradas no ciclo de Setembro/2026. Aluno(a): ${st.name}.`,
          amount,
          pixPayloadPast,
          `REC-2026-${invoiceSeq}`
        ]);

        // Fatura do Mês Atual (Pendente ou Paga)
        invoiceSeq++;
        const currNumber = `FAT-202610-${invoiceSeq}`;
        const pixPayloadCurr = `00020126580014br.gov.bcb.pix0136comercial@entrelinhas.online520400005303986540${amount.toFixed(2)}5802BR5925ESCOLA ENTRELINHAS LTDA6008CAMBORIU62070503***6304EF12`;
        const isPaidThisMonth = isDavi; // Davi já pagou, Ana e Nycolas estão com vencimento próximo

        await client.query(`
          INSERT INTO invoices 
            (invoice_number, student_id, title, description, amount, discount, net_amount, due_date, paid_date, payment_method, pix_code, status, receipt_number, notes)
          VALUES 
            ($1, $2, $3, $4, $5, 0.00, $5, CURRENT_DATE + INTERVAL '7 days', 
             CASE WHEN $6 = true THEN CURRENT_DATE - INTERVAL '1 day' ELSE NULL END, 
             'pix', $7, 
             CASE WHEN $6 = true THEN 'pago' ELSE 'pendente' END, 
             CASE WHEN $6 = true THEN $8 ELSE NULL END,
             'Mensalidade regular escolar. Chave Pix: comercial@entrelinhas.online')
        `, [
          currNumber,
          st.id,
          `Mensalidade Outubro/2026 - ${courseName}`,
          `Cobrança mensal referente ao ciclo de Outubro/2026. Aluno(a): ${st.name}. Vencimento dia 10.`,
          amount,
          isPaidThisMonth,
          pixPayloadCurr,
          `REC-2026-${invoiceSeq}`
        ]);
      }
      console.log(' Faturas de mensalidades cadastradas com sucesso!');
    }

    // 5. Leads do Site Institucional (leads_contacts)
    const leadsCount = await client.query('SELECT COUNT(*) FROM leads_contacts');
    if (parseInt(leadsCount.rows[0].count) === 0) {
      console.log(' Povoando Leads de captação de novos alunos...');
      await client.query(`
        INSERT INTO leads_contacts (name, phone, email, course_interest, student_grade, message, status)
        VALUES 
          ('Mariana Furtado', '(47) 98877-6655', 'mariana.furtado@email.com', 'Oficina de Redação Nota 1000', '3º Ano Ensino Médio / Vestibular', 'Gostaria de saber a disponibilidade de horários no período vespertino e os valores para acompanhamento de redação.', 'novo'),
          ('Rodrigo Alencar', '(47) 99112-3344', 'rodrigo.alencar@email.com', 'Português para Concursos Públicos', 'Concurseiro / Edital TJ-SC', 'Tenho interesse no preparatório com o Prof. Luciano. Gostaria de agendar uma aula experimental de sintaxe.', 'contatado'),
          ('Patrícia Becker (Mãe do Lucas)', '(47) 99456-7890', 'patricia.becker@email.com', 'Reforço Escolar de Matemática', '7º Ano Fundamental', 'Meu filho Lucas precisa recuperar a nota de matemática no 4º bimestre. Gostaria de iniciar nesta semana.', 'agendado')
      `);
      console.log(' Leads de captação cadastrados com sucesso!');
    }

    // 6. Atualiza links de reuniões ao vivo na grade de horários
    await client.query(`
      UPDATE teacher_schedules 
      SET live_meeting_url = 'https://meet.google.com/ent-aula-online'
      WHERE live_meeting_url IS NULL;
    `);

  } catch (err) {
    console.error('Erro ao semear dados do portal educacional:', err);
  }
}

module.exports = {
  pool,
  initDB,
  syncStudentTeacher,
  seedClassrooms, 
  seedUsers, 
  seedSchedules, 
  seedParentAccessAndAgenda, 
  seedEnrollmentsAndBindings,
  seedEducationalPortalData
};

