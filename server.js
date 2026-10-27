const express = require('express');
const cors = require('cors');
const path = require('path');
try { require('dotenv').config(); } catch (e) {}

const { pool, initDB, syncStudentTeacher } = require('./db');
const { seedData } = require('./seedData');
const { hashPassword, verifyPassword, generateToken, verifyToken } = require('./authUtils');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Upload de documentos de professor vem em base64 no JSON: limite maior só nessa rota
const jsonDefault = express.json();
const jsonLarge = express.json({ limit: '15mb' });
app.use((req, res, next) => (/^\/api\/teachers\/\d+\/documents$/.test(req.path) && req.method === 'POST' ? jsonLarge : jsonDefault)(req, res, next));
app.use(express.static(path.join(__dirname, 'public')));

// Configuração padrão de Data e Hora: Brasil / São Paulo (America/Sao_Paulo)
function getSaoPauloNow() {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'America/Sao_Paulo', 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit' 
  }).format(now); // YYYY-MM-DD
  const timeStr = new Intl.DateTimeFormat('pt-BR', { 
    timeZone: 'America/Sao_Paulo', 
    hour: '2-digit', 
    minute: '2-digit', 
    hour12: false 
  }).format(now); // HH:mm
  return { dateStr, timeStr };
}

function getSaoPauloDayOfWeek() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short'
  }).format(new Date());
  // Sun=0, Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[parts] !== undefined ? map[parts] : new Date().getDay();
}

function formatBRDateTime(dateVal, timeVal) {
  if (!dateVal) return '';
  let d = dateVal;
  if (d instanceof Date) {
    d = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
  } else if (typeof d === 'string') {
    const cleanDate = d.split('T')[0];
    const parts = cleanDate.split('-');
    if (parts.length === 3) d = `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
  }
  
  let formattedTime = '07h30m';
  if (timeVal) {
    const cleanTime = String(timeVal).trim();
    if (cleanTime.includes(':')) {
      const [h, m] = cleanTime.split(':');
      formattedTime = `${h.padStart(2, '0')}h${(m || '00').substring(0, 2).padStart(2, '0')}m`;
    } else if (/^\d{2}h\d{2}m$/.test(cleanTime)) {
      formattedTime = cleanTime;
    }
  }
  
  return `${d} - ${formattedTime}`;
}

// ==========================================
// MIDDLEWARES DE AUTENTICAÇÃO E PERMISSÕES
// ==========================================

/**
 * Sessão emitida antes de o usuário (ou aluno) existir não vale: protege contra números de
 * cadastro reaproveitados depois de uma limpeza do banco. Os tokens valem 14 dias; sem "iat",
 * a emissão é deduzida da expiração.
 */
function tokenPredatesRecord(decoded, createdAt) {
  if (!createdAt || !decoded || !decoded.exp) return false;
  const issuedAt = decoded.iat || (decoded.exp - 14 * 24 * 60 * 60);
  return issuedAt * 1000 < new Date(createdAt).getTime() - 60 * 1000;
}

/**
 * Middleware opcional/obrigatório para decodificar usuário do token Bearer
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso não autorizado. Faça login para continuar.' });
  }

  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Sessão expirada ou inválida. Por favor, entre novamente.' });
  }

  // Suporte a Pais / Responsáveis (autenticados via código de acesso da família ou conta de usuário)
  if (decoded.role === 'responsavel') {
    try {
      let user = null;
      if (decoded.id && decoded.id < 10000) {
        const userRes = await pool.query('SELECT * FROM users WHERE id = $1 AND status = \'ativo\'', [decoded.id]);
        if (userRes.rows.length > 0 && !tokenPredatesRecord(decoded, userRes.rows[0].created_at)) user = userRes.rows[0];
      }

      if (!user && decoded.student_id) {
        const stRes = await pool.query("SELECT * FROM students WHERE id = $1 AND status = 'ativo'", [decoded.student_id]);
        if (stRes.rows.length > 0 && !tokenPredatesRecord(decoded, stRes.rows[0].created_at)) {
          const st = stRes.rows[0];
          user = {
            id: decoded.id,
            name: st.parent_name || `Família de ${st.name}`,
            email: st.parent_email || decoded.email || 'pais@entrelinhas.online',
            role: 'responsavel',
            status: 'ativo',
            student_id: st.id,
            student_name: st.name
          };
        }
      }

      if (!user) {
        return res.status(401).json({ error: 'Aluno ou cadastro da família não encontrado no sistema.' });
      }

      req.user = user;
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao validar autenticação da família: ' + err.message });
    }
  }

  try {
    const userRes = await pool.query(`
      SELECT 
        u.id, u.name, u.email, u.role, u.status, u.student_id, u.created_at,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', s.id, 'name', s.name, 'code', s.code)) 
          FILTER (WHERE s.id IS NOT NULL), '[]'
        ) as subjects
      FROM users u
      LEFT JOIN teacher_subjects ts ON ts.user_id = u.id
      LEFT JOIN subjects s ON s.id = ts.subject_id
      WHERE u.id = $1 AND u.status = 'ativo'
      GROUP BY u.id
    `, [decoded.id]);

    if (userRes.rows.length === 0 || tokenPredatesRecord(decoded, userRes.rows[0].created_at)) {
      return res.status(401).json({ error: 'Usuário não encontrado ou inativo no sistema.' });
    }

    req.user = userRes.rows[0];
    delete req.user.created_at;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar autenticação: ' + err.message });
  }
}

/**
 * Middleware para decodificar usuário se token existir, sem barrar se não houver (para compatibilidade)
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);
    if (decoded) {
      try {
        if (decoded.role === 'responsavel') {
          let user = null;
          if (decoded.id && decoded.id < 10000) {
            const userRes = await pool.query('SELECT * FROM users WHERE id = $1 AND status = \'ativo\'', [decoded.id]);
            if (userRes.rows.length > 0 && !tokenPredatesRecord(decoded, userRes.rows[0].created_at)) user = userRes.rows[0];
          }
          if (!user && decoded.student_id) {
            const stRes = await pool.query("SELECT * FROM students WHERE id = $1 AND status = 'ativo'", [decoded.student_id]);
            if (stRes.rows.length > 0 && !tokenPredatesRecord(decoded, stRes.rows[0].created_at)) {
              const st = stRes.rows[0];
              user = {
                id: decoded.id,
                name: st.parent_name || `Família de ${st.name}`,
                email: st.parent_email || decoded.email || 'pais@entrelinhas.online',
                role: 'responsavel',
                status: 'ativo',
                student_id: st.id,
                student_name: st.name
              };
            }
          }
          if (user) req.user = user;
        } else {
          const userRes = await pool.query(`
            SELECT 
              u.id, u.name, u.email, u.role, u.status, u.student_id, u.created_at,
              COALESCE(
                json_agg(DISTINCT jsonb_build_object('id', s.id, 'name', s.name, 'code', s.code)) 
                FILTER (WHERE s.id IS NOT NULL), '[]'
              ) as subjects
            FROM users u
            LEFT JOIN teacher_subjects ts ON ts.user_id = u.id
            LEFT JOIN subjects s ON s.id = ts.subject_id
            WHERE u.id = $1 AND u.status = 'ativo'
            GROUP BY u.id
          `, [decoded.id]);
          if (userRes.rows.length > 0 && !tokenPredatesRecord(decoded, userRes.rows[0].created_at)) {
            req.user = userRes.rows[0];
            delete req.user.created_at;
          }
        }
      } catch (e) {}
    }
  }
  next();
}

/**
 * Middleware que restringe rota exclusivamente a Administradores
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado: funcionalidade exclusiva para Administradores.' });
  }
  next();
}

/**
 * Middleware para exigir papéis específicos
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Acesso negado: funcionalidade permitida apenas para [${roles.join(', ')}].` });
    }
    next();
  };
}

/**
 * Middleware que garante que o professor só altere/exclua seu próprio lançamento (ou seja Admin)
 */
async function ensureOwnLogOrAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Acesso não autorizado. Faça login para continuar.' });
  }
  if (req.user.role === 'admin') {
    return next();
  }
  const logId = parseInt(req.params.id);
  try {
    const logRes = await pool.query('SELECT teacher_id FROM class_logs WHERE id = $1', [logId]);
    if (logRes.rows.length === 0) {
      return res.status(404).json({ error: 'Registro de aula não encontrado.' });
    }
    if (logRes.rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ error: 'Acesso negado: você só pode editar ou excluir registros criados por você.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar permissão do lançamento: ' + err.message });
  }
}

// ==========================================
// REGRAS COMPARTILHADAS (DATAS, RECORRÊNCIA, GRADE E ACESSO)
// ==========================================

const VALID_LOG_STATUS = ['presente', 'falta'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Converte Date, 'YYYY-MM-DD...' ou 'DD/MM/YYYY' em 'YYYY-MM-DD' (ou null) */
function toISODate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const br = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

function isoToUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function daysBetween(fromIso, toIso) {
  return Math.round((isoToUTC(toIso) - isoToUTC(fromIso)) / 86400000);
}

function weekdayOf(iso) {
  return new Date(isoToUTC(iso)).getUTCDay();
}

/** Primeira data >= fromIso que cai no dia da semana informado */
function firstWeekdayOnOrAfter(fromIso, dayOfWeek) {
  const shift = (Number(dayOfWeek) - weekdayOf(fromIso) + 7) % 7;
  return new Date(isoToUTC(fromIso) + shift * 86400000).toISOString().slice(0, 10);
}

/**
 * Diz se um horário da grade acontece numa data (YYYY-MM-DD).
 * - semanal: toda semana no dia configurado
 * - quinzenal: semana sim, semana não, contando da 1ª ocorrência a partir do início
 * - custom_dias: a cada N dias, contando da 1ª ocorrência a partir do início
 * A mesma regra existe no front (isScheduleActiveOnDate em public/app.js).
 */
function isScheduleOnDate(sched, dateIso) {
  const start = toISODate(sched.start_date) || toISODate(sched.student_start_date) || toISODate(sched.created_at);
  const end = toISODate(sched.end_date);
  if (start && dateIso < start) return false;
  if (end && dateIso > end) return false;

  const freq = sched.frequency_type || sched.student_frequency_type || 'semanal';
  const anchor = firstWeekdayOnOrAfter(start || dateIso, sched.day_of_week);
  const diff = daysBetween(anchor, dateIso);

  if (freq === 'custom_dias') {
    const interval = parseInt(sched.recurrence_interval_days || sched.student_custom_interval_days) || 3;
    return diff >= 0 && diff % interval === 0;
  }

  if (weekdayOf(dateIso) !== Number(sched.day_of_week)) return false;
  if (freq === 'quinzenal') return diff >= 0 && (diff / 7) % 2 === 0;
  return true;
}

/** Filtro SQL: alunos de um professor (responsável, com aula ativa na grade ou com aula lançada por ele) */
function teacherStudentsSQL(studentAlias, paramRef) {
  return `(
    ${studentAlias}.assigned_teacher_id = ${paramRef}
    OR EXISTS (SELECT 1 FROM teacher_schedules tsx WHERE tsx.student_id = ${studentAlias}.id AND tsx.teacher_id = ${paramRef} AND tsx.status = 'ativo')
    OR EXISTS (SELECT 1 FROM class_logs clx WHERE clx.student_id = ${studentAlias}.id AND clx.teacher_id = ${paramRef})
  )`;
}

async function teacherCanAccessStudent(teacherId, studentId) {
  const r = await pool.query(
    `SELECT 1 FROM students st WHERE st.id = $1 AND ${teacherStudentsSQL('st', '$2')}`,
    [studentId, teacherId]
  );
  return r.rows.length > 0;
}

/**
 * Resolve qual aluno a requisição pode consultar.
 * Família: sempre o próprio aluno. Professor: só os seus alunos. Admin: qualquer um.
 * Retorna { studentId } ou { error, status }.
 */
async function resolveStudentScope(req, requestedId) {
  const role = req.user && req.user.role;
  if (role === 'responsavel') {
    if (requestedId && String(requestedId) !== String(req.user.student_id)) {
      return { error: 'Acesso negado: você só pode consultar o aluno vinculado ao seu acesso.', status: 403 };
    }
    return { studentId: req.user.student_id };
  }
  if (role === 'admin') {
    return requestedId ? { studentId: requestedId } : { error: 'Aluno não especificado.', status: 400 };
  }
  if (role === 'professor') {
    if (!requestedId) return { error: 'Aluno não especificado.', status: 400 };
    if (!(await teacherCanAccessStudent(req.user.id, requestedId))) {
      return { error: 'Acesso negado: este aluno não está vinculado a você.', status: 403 };
    }
    return { studentId: requestedId };
  }
  return { error: 'Acesso negado.', status: 403 };
}

/**
 * Valida um horário da grade antes de gravar. Retorna { error } ou { classroomId }.
 * Regras: formato e ordem dos horários; professor ativo que leciona a matéria;
 * professor não pode estar em dois lugares ao mesmo tempo; aluno não pode ter duas aulas
 * simultâneas; limite de professores da sala; capacidade da sala e da matéria.
 * Os conflitos são avaliados por dia da semana e faixa de horário.
 */
async function validateScheduleSlot(db, { scheduleId = null, teacherId, studentId = null, subjectId = null, classroomId = null, dayOfWeek, startTime, endTime }) {
  if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '')) {
    return { error: 'Informe os horários no formato HH:MM (ex.: 08:00).' };
  }
  if (endTime <= startTime) return { error: 'O horário final precisa ser depois do horário inicial.' };
  if (!(Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6)) return { error: 'Dia da semana inválido.' };

  const teacherRes = await db.query('SELECT id, name, role, status FROM users WHERE id = $1', [teacherId]);
  const teacher = teacherRes.rows[0];
  if (!teacher || teacher.role !== 'professor') return { error: 'Selecione um professor válido.' };
  if (teacher.status !== 'ativo') return { error: `O professor ${teacher.name} está inativo.` };

  let subject = null;
  if (subjectId) {
    subject = (await db.query('SELECT * FROM subjects WHERE id = $1', [subjectId])).rows[0];
    if (!subject) return { error: 'Matéria não encontrada.' };
    const teaches = await db.query('SELECT 1 FROM teacher_subjects WHERE user_id = $1 AND subject_id = $2', [teacherId, subjectId]);
    if (teaches.rows.length === 0) {
      return { error: `${teacher.name} não leciona ${subject.name}. Vincule a matéria ao professor em Gestão > Professores.` };
    }
  }

  if (studentId) {
    const st = (await db.query('SELECT id, name, status FROM students WHERE id = $1', [studentId])).rows[0];
    if (!st) return { error: 'Aluno não encontrado.' };
    if (st.status !== 'ativo') return { error: `O aluno ${st.name} está inativo.` };
  }

  const roomId = classroomId || (subject && subject.classroom_id) || null;
  const classroom = roomId ? (await db.query('SELECT * FROM classrooms WHERE id = $1', [roomId])).rows[0] || null : null;

  // Horários ativos que se sobrepõem no mesmo dia (com a sala efetiva de cada um)
  const overlapRes = await db.query(`
    SELECT ts.id, ts.teacher_id, ts.student_id, ts.subject_id, ts.start_time, ts.end_time,
           COALESCE(ts.classroom_id, sub.classroom_id) AS room_id,
           u.name AS teacher_name, st.name AS student_name
    FROM teacher_schedules ts
    JOIN users u ON u.id = ts.teacher_id
    LEFT JOIN subjects sub ON sub.id = ts.subject_id
    LEFT JOIN students st ON st.id = ts.student_id
    WHERE ts.status = 'ativo'
      AND ts.day_of_week = $1
      AND ts.start_time < $2 AND ts.end_time > $3
      AND ($4::int IS NULL OR ts.id <> $4)
  `, [dayOfWeek, endTime, startTime, scheduleId]);
  const overlaps = overlapRes.rows;

  // 1. Professor em dois lugares ao mesmo tempo (só quando as duas salas estão definidas e são diferentes;
  //    horário sem sala não conta como "outra sala")
  const teacherElsewhere = overlaps.find(o => o.teacher_id === teacherId && o.room_id && roomId && o.room_id !== roomId);
  if (teacherElsewhere) {
    return { error: `Conflito de agenda: ${teacher.name} já tem aula em outra sala neste horário (${teacherElsewhere.start_time} - ${teacherElsewhere.end_time}).` };
  }

  // 2. Aluno com duas aulas simultâneas
  if (studentId) {
    const studentBusy = overlaps.find(o => o.student_id === studentId);
    if (studentBusy) {
      return { error: `Conflito de agenda: ${studentBusy.student_name} já tem aula com ${studentBusy.teacher_name} neste horário (${studentBusy.start_time} - ${studentBusy.end_time}).` };
    }
  }

  if (classroom) {
    // Horários do mesmo professor sem sala definida contam como ocupando a sala dele
    const inRoom = overlaps.filter(o => o.room_id === classroom.id || (!o.room_id && o.teacher_id === teacherId));

    // 3. Limite de professores simultâneos na sala
    const otherTeachers = new Set(inRoom.filter(o => o.teacher_id !== teacherId).map(o => o.teacher_id));
    const teacherLimit = classroom.capacity_teachers || 1;
    if (otherTeachers.size >= teacherLimit) {
      const c = inRoom.find(o => o.teacher_id !== teacherId);
      return { error: `Conflito de Sala: "${classroom.name}" comporta ${teacherLimit} professor(es) por vez e já está reservada para ${c.teacher_name} neste horário (${c.start_time} - ${c.end_time}).` };
    }

    // 4. Capacidade de alunos da sala
    if (studentId) {
      const roomStudents = new Set(inRoom.filter(o => o.student_id).map(o => o.student_id));
      if (classroom.capacity_students && roomStudents.size >= classroom.capacity_students) {
        return { error: `Capacidade máxima excedida: a sala "${classroom.name}" comporta ${classroom.capacity_students} aluno(s) e já tem ${roomStudents.size} neste horário.` };
      }
    }
  }

  // 5. Limite de alunos da matéria (ex.: Informática limitada pelos computadores)
  if (studentId && subject && subject.max_students) {
    const subjectStudents = new Set(
      overlaps.filter(o => o.subject_id === subject.id && o.teacher_id === teacherId && o.student_id).map(o => o.student_id)
    );
    if (subjectStudents.size >= subject.max_students) {
      const resources = Array.isArray(subject.required_resources) ? subject.required_resources.join(', ') : '';
      return { error: `Capacidade máxima excedida: ${subject.name} aceita ${subject.max_students} aluno(s) por horário${resources ? ` (recursos: ${resources})` : ''} e já tem ${subjectStudents.size} neste período.` };
    }
  }

  return { classroomId: roomId };
}

function addMinutesToTime(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  if (total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    const userRes = await pool.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(name) = LOWER($1)`,
      [email.trim()]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas. Verifique seu e-mail e senha.' });
    }

    const user = userRes.rows[0];
    if (user.status !== 'ativo') {
      return res.status(403).json({ error: 'Este usuário está inativo no sistema. Contate o administrador.' });
    }

    const isValid = verifyPassword(password, user.password_hash, user.salt);
    if (!isValid) {
      return res.status(401).json({ error: 'Credenciais inválidas. Verifique seu e-mail e senha.' });
    }

    // Busca matérias associadas ao usuário
    const subjectsRes = await pool.query(`
      SELECT s.id, s.name, s.code
      FROM teacher_subjects ts
      JOIN subjects s ON s.id = ts.subject_id
      WHERE ts.user_id = $1
    `, [user.id]);

    const token = generateToken({ id: user.id, role: user.role, email: user.email, student_id: user.student_id });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        student_id: user.student_id,
        subjects: subjectsRes.rows
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login específico para Pais e Responsáveis (por Código do Aluno ou E-mail)
app.post('/api/auth/parent-login', async (req, res) => {
  try {
    const access_code = req.body.access_code || req.body.parent_access_code;
    const { email, password } = req.body;

    let student = null;
    let parentUser = null;

    if (access_code && access_code.trim()) {
      const code = access_code.trim().toUpperCase();
      const stRes = await pool.query(`
        SELECT st.*,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object('id', sub.id, 'name', sub.name, 'code', sub.code)) 
            FILTER (WHERE sub.id IS NOT NULL), '[]'
          ) as subjects
        FROM students st
        LEFT JOIN student_subjects ss ON ss.student_id = st.id
        LEFT JOIN subjects sub ON sub.id = ss.subject_id
        WHERE UPPER(st.parent_access_code) = $1
          AND st.status = 'ativo'
        GROUP BY st.id
        LIMIT 1
      `, [code]);

      if (stRes.rows.length === 0) {
        return res.status(401).json({ error: 'Código de acesso da família não encontrado. Verifique o código com a escola.' });
      }
      student = stRes.rows[0];
    } else if (email && password) {
      const userRes = await pool.query(
        'SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND role = $2',
        [email.trim(), 'responsavel']
      );
      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: 'Cadastro de responsável não encontrado com este e-mail.' });
      }
      parentUser = userRes.rows[0];
      if (!verifyPassword(password, parentUser.password_hash, parentUser.salt)) {
        return res.status(401).json({ error: 'Senha incorreta para a conta da família.' });
      }

      if (parentUser.student_id) {
        const stRes = await pool.query('SELECT * FROM students WHERE id = $1', [parentUser.student_id]);
        if (stRes.rows.length > 0) student = stRes.rows[0];
      }
    } else {
      return res.status(400).json({ error: 'Informe o Código de Acesso do Aluno ou E-mail e Senha.' });
    }

    if (!student) {
      return res.status(404).json({ error: 'Nenhum aluno vinculado a este acesso.' });
    }

    const token = generateToken({
      id: parentUser ? parentUser.id : (student.id * 10000),
      role: 'responsavel',
      student_id: student.id,
      email: student.parent_email || (parentUser ? parentUser.email : 'pais@entrelinhas.online')
    });

    res.json({
      token,
      user: {
        id: parentUser ? parentUser.id : (student.id * 10000),
        name: student.parent_name || `Família de ${student.name}`,
        email: student.parent_email || (parentUser ? parentUser.email : ''),
        role: 'responsavel',
        student_id: student.id,
        student_name: student.name
      },
      student
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Perfil atual (Validar token)
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Lista de usuários para login rápido em tela de demonstração
app.get('/api/auth/quick-users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id, u.name, u.email, u.role,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', s.id, 'name', s.name, 'code', s.code)) 
          FILTER (WHERE s.id IS NOT NULL), '[]'
        ) as subjects
      FROM users u
      LEFT JOIN teacher_subjects ts ON ts.user_id = u.id
      LEFT JOIN subjects s ON s.id = ts.subject_id
      WHERE u.status = 'ativo'
      GROUP BY u.id
      ORDER BY u.role ASC, u.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROTAS DE GESTÃO DO ADMIN (PROFESSORES)
// ==========================================

// Listar todos os professores (com turmas, total de lançamentos, última aula e alunos vinculados)
app.get('/api/teachers', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id, u.name, u.email, u.phone, u.role, u.status, u.created_at,
        (SELECT COUNT(*) FROM teacher_documents td WHERE td.teacher_id = u.id) as total_documents,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', s.id, 'name', s.name, 'code', s.code)) 
          FILTER (WHERE s.id IS NOT NULL), '[]'
        ) as subjects,
        COUNT(DISTINCT cl.id) as total_classes_logged,
        MAX(cl.class_date) as last_class_date,
        (SELECT COUNT(DISTINCT tsched.student_id) FROM teacher_schedules tsched WHERE tsched.teacher_id = u.id AND tsched.status = 'ativo') as total_students_linked
      FROM users u
      LEFT JOIN teacher_subjects ts ON ts.user_id = u.id
      LEFT JOIN subjects s ON s.id = ts.subject_id
      LEFT JOIN class_logs cl ON cl.teacher_id = u.id
      WHERE u.role = 'professor' OR u.role = 'admin'
      GROUP BY u.id
      ORDER BY u.role ASC, u.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastrar novo professor (Admin)
app.post('/api/teachers', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, email, password, role = 'professor', subject_ids = [], phone } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    if (!['admin', 'professor'].includes(role)) {
      return res.status(400).json({ error: 'Perfil inválido. Use "admin" ou "professor".' });
    }

    const existing = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe um professor ou usuário com este e-mail.' });
    }

    await client.query('BEGIN');
    const { hash, salt } = hashPassword(password);
    const userRes = await client.query(`
      INSERT INTO users (name, email, password_hash, salt, role, status, phone)
      VALUES ($1, $2, $3, $4, $5, 'ativo', $6)
      RETURNING id, name, email, phone, role, status, created_at
    `, [name.trim(), email.trim().toLowerCase(), hash, salt, role, (phone || '').trim() || null]);
    const newTeacher = userRes.rows[0];

    if (Array.isArray(subject_ids) && subject_ids.length > 0) {
      for (const subId of subject_ids) {
        await client.query(`
          INSERT INTO teacher_subjects (user_id, subject_id)
          VALUES ($1, $2) ON CONFLICT DO NOTHING
        `, [newTeacher.id, subId]);
      }
    }

    await client.query('COMMIT');
    res.status(201).json(newTeacher);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Tira da grade os horários de um professor (inativado/excluído) e recalcula os alunos afetados
async function deactivateTeacherSchedules(db, teacherId) {
  const affected = await db.query(`
    UPDATE teacher_schedules SET status = 'inativo', updated_at = CURRENT_TIMESTAMP
    WHERE teacher_id = $1 AND status = 'ativo'
    RETURNING student_id
  `, [teacherId]);
  const studentIds = new Set(affected.rows.map(r => r.student_id).filter(Boolean));
  const assigned = await db.query('SELECT id FROM students WHERE assigned_teacher_id = $1', [teacherId]);
  assigned.rows.forEach(r => studentIds.add(r.id));
  for (const sid of studentIds) await syncStudentTeacher(db, sid);
  return { schedules: affected.rows.length, students: studentIds.size };
}

// Editar professor (Admin)
app.put('/api/teachers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id);
    const { name, email, password, role, status, subject_ids, phone } = req.body;

    if (role && !['admin', 'professor'].includes(role)) {
      return res.status(400).json({ error: 'Perfil inválido. Use "admin" ou "professor".' });
    }
    if (status && !['ativo', 'inativo'].includes(status)) {
      return res.status(400).json({ error: 'Status inválido. Use "ativo" ou "inativo".' });
    }
    if (id === req.user.id && (status === 'inativo' || (role && role !== 'admin'))) {
      return res.status(400).json({ error: 'Você não pode inativar nem rebaixar o seu próprio usuário logado.' });
    }
    if (email && email.trim()) {
      const dup = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2', [email.trim(), id]);
      if (dup.rows.length > 0) return res.status(400).json({ error: 'Já existe outro usuário com este e-mail.' });
    }

    // Não deixa remover do professor uma matéria que ele ainda dá na grade
    if (Array.isArray(subject_ids)) {
      const keep = subject_ids.map(Number);
      const blocked = await client.query(`
        SELECT DISTINCT sub.name FROM teacher_schedules ts
        JOIN subjects sub ON sub.id = ts.subject_id
        WHERE ts.teacher_id = $1 AND ts.status = 'ativo' AND NOT (ts.subject_id = ANY($2::int[]))
      `, [id, keep]);
      if (blocked.rows.length > 0 && status !== 'inativo') {
        return res.status(400).json({
          error: `Não é possível remover ${blocked.rows.map(r => r.name).join(', ')}: o professor ainda tem aulas dessa(s) matéria(s) na grade. Remova ou transfira os horários primeiro.`
        });
      }
    }

    await client.query('BEGIN');

    if (password && password.trim()) {
      const { hash, salt } = hashPassword(password.trim());
      await client.query('UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3', [hash, salt, id]);
    }

    const updateRes = await client.query(`
      UPDATE users
      SET name = COALESCE($1, name),
          email = COALESCE($2, email),
          role = COALESCE($3, role),
          status = COALESCE($4, status),
          phone = CASE WHEN $6::boolean THEN $7 ELSE phone END
      WHERE id = $5
      RETURNING id, name, email, phone, role, status
    `, [name ? name.trim() : null, email ? email.trim().toLowerCase() : null, role || null, status || null, id,
        phone !== undefined, phone !== undefined ? (String(phone || '').trim() || null) : null]);

    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Professor não encontrado.' });
    }

    if (Array.isArray(subject_ids)) {
      await client.query('DELETE FROM teacher_subjects WHERE user_id = $1', [id]);
      for (const subId of subject_ids) {
        await client.query('INSERT INTO teacher_subjects (user_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, subId]);
      }
    }

    const teacher = updateRes.rows[0];
    let released = null;
    if (teacher.status !== 'ativo' || teacher.role !== 'professor') {
      released = await deactivateTeacherSchedules(client, id);
    }

    await client.query('COMMIT');
    const extra = released && released.schedules > 0
      ? ` ${released.schedules} horário(s) dele saíram da grade e ${released.students} aluno(s) foram recalculados.`
      : '';
    res.json({ message: 'Professor atualizado com sucesso!' + extra, teacher });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Excluir ou inativar professor (Admin)
app.delete('/api/teachers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Você não pode excluir o seu próprio usuário logado.' });
    }

    const exists = await client.query('SELECT id FROM users WHERE id = $1', [id]);
    if (exists.rows.length === 0) return res.status(404).json({ error: 'Professor não encontrado.' });

    await client.query('BEGIN');
    const released = await deactivateTeacherSchedules(client, id);

    const logsRes = await client.query('SELECT COUNT(*) FROM class_logs WHERE teacher_id = $1', [id]);
    const hasLogs = parseInt(logsRes.rows[0].count) > 0;
    let message;
    if (hasLogs) {
      // Inativa para não quebrar o histórico de aulas lançadas
      await client.query("UPDATE users SET status = 'inativo' WHERE id = $1", [id]);
      message = 'O professor possui aulas registradas no histórico. Seu status foi alterado para inativo.';
    } else {
      await client.query('DELETE FROM users WHERE id = $1', [id]);
      message = 'Professor excluído com sucesso.';
    }
    await client.query('COMMIT');

    if (released.schedules > 0) {
      message += ` ${released.schedules} horário(s) saíram da grade e ${released.students} aluno(s) foram recalculados.`;
    }
    res.json({ message });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// DOCUMENTOS DOS PROFESSORES (Admin)
// ==========================================
const TEACHER_DOC_CATEGORIES = ['curriculo', 'documento_pessoal', 'contrato', 'certificado', 'outro'];
const MAX_DOC_BYTES = 10 * 1024 * 1024;

app.get('/api/teachers/:id/documents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, teacher_id, category, description, file_name, mime_type, size_bytes, created_at
      FROM teacher_documents WHERE teacher_id = $1 ORDER BY created_at DESC
    `, [parseInt(req.params.id)]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/teachers/:id/documents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const teacherId = parseInt(req.params.id);
    const { file_name, mime_type, data_base64, category = 'outro', description } = req.body;
    if (!file_name || !data_base64) return res.status(400).json({ error: 'Selecione um arquivo para enviar.' });
    if (!TEACHER_DOC_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Tipo de documento inválido.' });
    const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [teacherId]);
    if (exists.rows.length === 0) return res.status(404).json({ error: 'Professor não encontrado.' });

    const buffer = Buffer.from(String(data_base64).replace(/^data:[^,]*,/, ''), 'base64');
    if (buffer.length === 0) return res.status(400).json({ error: 'Arquivo vazio.' });
    if (buffer.length > MAX_DOC_BYTES) return res.status(400).json({ error: 'O arquivo passa do limite de 10 MB.' });

    const r = await pool.query(`
      INSERT INTO teacher_documents (teacher_id, category, description, file_name, mime_type, size_bytes, data, uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, teacher_id, category, description, file_name, mime_type, size_bytes, created_at
    `, [teacherId, category, (description || '').trim() || null, String(file_name).slice(0, 255),
        mime_type || 'application/octet-stream', buffer.length, buffer, req.user.id]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/teacher-documents/:docId/download', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT file_name, mime_type, data FROM teacher_documents WHERE id = $1', [parseInt(req.params.docId)]);
    const doc = r.rows[0];
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado.' });
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`);
    res.send(doc.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/teacher-documents/:docId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM teacher_documents WHERE id = $1 RETURNING id', [parseInt(req.params.docId)]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Documento não encontrado.' });
    res.json({ message: 'Documento removido.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROTAS DE GESTÃO DE ALUNOS
// ==========================================

// Colunas comuns da listagem/detalhe de alunos. As contagens usam subconsultas para
// não multiplicar o total de aulas pelo número de matérias do aluno.
const STUDENT_SELECT = `
  SELECT
    st.*,
    to_char(st.birth_date, 'YYYY-MM-DD') as birth_date,
    to_char(st.birth_date, 'DD/MM') as birthday_br,
    u_teach.name as assigned_teacher_name,
    u_teach.email as assigned_teacher_email,
    COALESCE((
      SELECT json_agg(jsonb_build_object('id', sub.id, 'name', sub.name, 'code', sub.code) ORDER BY sub.name)
      FROM student_subjects ss JOIN subjects sub ON sub.id = ss.subject_id
      WHERE ss.student_id = st.id
    ), '[]') as subjects,
    lg.total_classes,
    lg.total_presences,
    lg.total_absences,
    lg.last_class_date,
    to_char(lg.last_class_date, 'DD/MM/YYYY') as last_class_date_br,
    (
      SELECT to_char(cl_last.class_date, 'DD/MM/YYYY') || ' - ' ||
             CASE
               WHEN cl_last.class_time IS NOT NULL AND cl_last.class_time != ''
               THEN replace(substring(cl_last.class_time from 1 for 5), ':', 'h') || 'm'
               WHEN cl_last.created_at IS NOT NULL
               THEN to_char(cl_last.created_at AT TIME ZONE 'America/Sao_Paulo', 'HH24"h"MI"m"')
               ELSE '07h30m'
             END
      FROM class_logs cl_last
      WHERE cl_last.student_id = st.id
      ORDER BY cl_last.class_date DESC, cl_last.id DESC
      LIMIT 1
    ) as last_class_formatted
  FROM students st
  LEFT JOIN users u_teach ON u_teach.id = st.assigned_teacher_id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) as total_classes,
      COUNT(*) FILTER (WHERE cl.status = 'presente') as total_presences,
      COUNT(*) FILTER (WHERE cl.status = 'falta') as total_absences,
      MAX(cl.class_date) as last_class_date
    FROM class_logs cl
    WHERE cl.student_id = st.id
  ) lg ON true
`;

const VALID_FREQUENCIES = ['semanal', 'quinzenal', 'custom_dias'];

async function getActiveProfessor(db, teacherId) {
  const r = await db.query("SELECT id, name FROM users WHERE id = $1 AND role = 'professor' AND status = 'ativo'", [teacherId]);
  return r.rows[0] || null;
}

// Listar alunos (professor vê só os seus; família só o próprio aluno)
app.get('/api/students', authenticateToken, async (req, res) => {
  try {
    const { subject_id, search, enrollment_status } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (req.user.role === 'professor') {
      params.push(req.user.id);
      where += ` AND ${teacherStudentsSQL('st', '$' + params.length)}`;
    } else if (req.user.role === 'responsavel') {
      params.push(req.user.student_id);
      where += ` AND st.id = $${params.length}`;
    }

    if (subject_id) {
      params.push(subject_id);
      where += ` AND st.id IN (SELECT student_id FROM student_subjects WHERE subject_id = $${params.length})`;
    }
    if (enrollment_status) {
      params.push(enrollment_status);
      where += ` AND st.enrollment_status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      where += ` AND LOWER(st.name) LIKE $${params.length}`;
    }

    const result = await pool.query(`${STUDENT_SELECT} ${where} ORDER BY st.name ASC`, params);

    // Oculta código sigiloso dos pais caso não seja Administrador
    if (req.user.role !== 'admin') {
      result.rows.forEach(r => { delete r.parent_access_code; });
    }

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detalhes de um aluno + histórico de aulas
app.get('/api/students/:id', authenticateToken, async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.params.id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });

    const studentRes = await pool.query(`${STUDENT_SELECT} WHERE st.id = $1`, [scope.studentId]);
    if (studentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado' });
    }

    if (req.user.role !== 'admin') {
      delete studentRes.rows[0].parent_access_code;
    }

    const logsRes = await pool.query(`
      SELECT
        cl.*,
        sub.name as subject_name,
        to_char(cl.class_date, 'DD/MM/YYYY') as class_date_br,
        COALESCE(cl.class_time, to_char(cl.created_at AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI')) as class_time_display,
        to_char(cl.class_date, 'DD/MM/YYYY') || ' - ' ||
        COALESCE(
          CASE
            WHEN cl.class_time IS NOT NULL AND cl.class_time != ''
            THEN replace(substring(cl.class_time from 1 for 5), ':', 'h') || 'm'
            ELSE to_char(cl.created_at AT TIME ZONE 'America/Sao_Paulo', 'HH24"h"MI"m"')
          END,
          '07h30m'
        ) as formatted_date_time
      FROM class_logs cl
      JOIN subjects sub ON sub.id = cl.subject_id
      WHERE cl.student_id = $1
      ORDER BY cl.class_date DESC, cl.id DESC
    `, [scope.studentId]);

    res.json({
      student: studentRes.rows[0],
      logs: logsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar alunos aguardando professor / matrícula pendente
app.get('/api/students-pending-teacher', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        st.*,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', sub.id, 'name', sub.name, 'code', sub.code))
          FILTER (WHERE sub.id IS NOT NULL), '[]'
        ) as subjects
      FROM students st
      LEFT JOIN student_subjects ss ON ss.student_id = st.id
      LEFT JOIN subjects sub ON sub.id = ss.subject_id
      WHERE (st.enrollment_status = 'aguardando_professor' OR st.assigned_teacher_id IS NULL)
        AND st.status = 'ativo'
      GROUP BY st.id
      ORDER BY st.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validações comuns de cadastro/edição de aluno. Retorna mensagem de erro ou null.
async function validateStudentPayload(db, body, studentId = null) {
  const { frequency_type, preferred_time, custom_interval_days, duration_minutes, parent_access_code, subject_ids, status } = body;
  if (frequency_type && !VALID_FREQUENCIES.includes(frequency_type)) {
    return 'Frequência inválida. Use semanal, quinzenal ou custom_dias.';
  }
  if (preferred_time && !TIME_RE.test(preferred_time)) return 'Horário preferido deve estar no formato HH:MM.';
  if (custom_interval_days !== undefined && custom_interval_days !== null && custom_interval_days !== '' &&
      !(parseInt(custom_interval_days) >= 1)) {
    return 'O intervalo em dias deve ser um número maior que zero.';
  }
  if (duration_minutes !== undefined && duration_minutes !== null && duration_minutes !== '' &&
      !(parseInt(duration_minutes) >= 15 && parseInt(duration_minutes) <= 480)) {
    return 'A duração da aula deve ficar entre 15 e 480 minutos.';
  }
  if (status && !['ativo', 'inativo'].includes(status)) return 'Status do aluno inválido.';
  if (body.birth_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.birth_date)) return 'Data de nascimento inválida.';
  if (parent_access_code && parent_access_code.trim()) {
    const dup = await db.query(
      'SELECT id FROM students WHERE UPPER(parent_access_code) = UPPER($1) AND ($2::int IS NULL OR id <> $2)',
      [parent_access_code.trim(), studentId]
    );
    if (dup.rows.length > 0) return 'Este código de acesso da família já está em uso por outro aluno.';
  }
  if (Array.isArray(subject_ids) && subject_ids.length > 0) {
    const found = await db.query('SELECT COUNT(*) FROM subjects WHERE id = ANY($1::int[])', [subject_ids.map(Number)]);
    if (parseInt(found.rows[0].count) !== new Set(subject_ids.map(Number)).size) return 'Uma ou mais matérias selecionadas não existem.';
  }
  return null;
}

// Gera um código de acesso da família que ainda não esteja em uso
async function generateParentCode(db, name) {
  const prefix = name.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '').substring(0, 3).toUpperCase() || 'ALU';
  for (let i = 0; i < 20; i++) {
    const code = `PAIS-${prefix}${Math.floor(100 + Math.random() * 900)}`;
    const r = await db.query('SELECT 1 FROM students WHERE UPPER(parent_access_code) = $1', [code]);
    if (r.rows.length === 0) return code;
  }
  return `PAIS-${prefix}${Date.now().toString().slice(-6)}`;
}

// Cadastrar novo Aluno com Matrícula & Frequência (Exclusivo Administrador)
app.post('/api/students', authenticateToken, requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      name, objective_grade, start_date, end_date,
      parent_name, parent_email, parent_phone, parent_access_code,
      subject_ids, frequency_type, custom_interval_days, preferred_days, preferred_time,
      duration_minutes, assigned_teacher_id, enrollment_notes,
      address, birth_date, school_name, school_contact_name, school_phone
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome do aluno é obrigatório' });
    }
    const validationError = await validateStudentPayload(client, req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    let teacher = null;
    if (assigned_teacher_id) {
      teacher = await getActiveProfessor(client, parseInt(assigned_teacher_id));
      if (!teacher) return res.status(400).json({ error: 'O professor selecionado não existe ou está inativo.' });
    }

    const cleanCode = parent_access_code && parent_access_code.trim()
      ? parent_access_code.trim().toUpperCase()
      : await generateParentCode(client, name);
    const freq = frequency_type || 'semanal';
    const subjectIds = Array.isArray(subject_ids) ? subject_ids.map(Number) : [];

    await client.query('BEGIN');
    const studentRes = await client.query(
      `INSERT INTO students (
        name, objective_grade, start_date, end_date, status,
        parent_name, parent_email, parent_phone, parent_access_code,
        frequency_type, custom_interval_days, preferred_days, preferred_time, duration_minutes,
        enrollment_status, assigned_teacher_id, enrollment_notes,
        address, birth_date, school_name, school_contact_name, school_phone
       )
       VALUES ($1, $2, $3, $4, 'ativo', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING *`,
      [
        name.trim(),
        objective_grade || '',
        start_date || '',
        end_date || '',
        parent_name || '',
        parent_email || '',
        parent_phone || '',
        cleanCode,
        freq,
        custom_interval_days ? parseInt(custom_interval_days) : (freq === 'quinzenal' ? 14 : 7),
        preferred_days || '1',
        preferred_time || '08:00',
        duration_minutes ? parseInt(duration_minutes) : 60,
        teacher ? 'ativo' : 'aguardando_professor',
        teacher ? teacher.id : null,
        enrollment_notes || null,
        (address || '').trim() || null,
        birth_date || null,
        (school_name || '').trim() || null,
        (school_contact_name || '').trim() || null,
        (school_phone || '').trim() || null
      ]
    );
    const newStudent = studentRes.rows[0];

    for (const subId of subjectIds) {
      await client.query(
        `INSERT INTO student_subjects (student_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [newStudent.id, subId]
      );
    }

    // Com professor e dias preferidos, já gera a grade — passando pelas mesmas validações da Grade
    if (teacher && preferred_days) {
      const days = [...new Set(String(preferred_days).split(',').map(d => parseInt(d.trim())).filter(d => d >= 0 && d <= 6))];

      let subId = null;
      if (subjectIds.length > 0) {
        const taught = await client.query(
          'SELECT subject_id FROM teacher_subjects WHERE user_id = $1 AND subject_id = ANY($2::int[]) ORDER BY subject_id',
          [teacher.id, subjectIds]
        );
        if (taught.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `${teacher.name} não leciona nenhuma das matérias selecionadas para o aluno.` });
        }
        subId = taught.rows[0].subject_id;
      }

      const startTime = newStudent.preferred_time || '08:00';
      const endTime = addMinutesToTime(startTime, newStudent.duration_minutes || 60);
      if (!endTime) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'O horário preferido somado à duração passa da meia-noite.' });
      }
      const scheduleStart = toISODate(newStudent.start_date);

      for (const day of days) {
        const check = await validateScheduleSlot(client, {
          teacherId: teacher.id, studentId: newStudent.id, subjectId: subId,
          dayOfWeek: day, startTime, endTime
        });
        if (check.error) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Não foi possível montar a grade do aluno: ${check.error}` });
        }
        await client.query(`
          INSERT INTO teacher_schedules
            (teacher_id, student_id, subject_id, classroom_id, day_of_week, start_time, end_time, frequency_type, recurrence_interval_days, room_or_info, notes, status, start_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Presencial / Online', $10, 'ativo', COALESCE($11::date, CURRENT_DATE))
        `, [
          teacher.id, newStudent.id, subId, check.classroomId, day, startTime, endTime,
          freq, newStudent.custom_interval_days || 7, `Matrícula: ${newStudent.name}`, scheduleStart
        ]);
      }
    }

    await client.query('COMMIT');
    res.status(201).json(newStudent);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Editar Aluno (Exclusivo Administrador)
app.put('/api/students/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id);
    const body = req.body;
    const has = key => Object.prototype.hasOwnProperty.call(body, key);

    const currentRes = await client.query('SELECT * FROM students WHERE id = $1', [id]);
    const current = currentRes.rows[0];
    if (!current) return res.status(404).json({ error: 'Aluno não encontrado' });

    const validationError = await validateStudentPayload(client, body, id);
    if (validationError) return res.status(400).json({ error: validationError });

    // Matérias que o aluno ainda cursa na grade não podem ser removidas
    if (Array.isArray(body.subject_ids)) {
      const keep = body.subject_ids.map(Number);
      const blocked = await client.query(`
        SELECT DISTINCT sub.name FROM teacher_schedules ts
        JOIN subjects sub ON sub.id = ts.subject_id
        WHERE ts.student_id = $1 AND ts.status = 'ativo' AND NOT (ts.subject_id = ANY($2::int[]))
      `, [id, keep]);
      if (blocked.rows.length > 0) {
        return res.status(400).json({
          error: `Não é possível remover ${blocked.rows.map(r => r.name).join(', ')}: o aluno ainda tem aula dessa(s) matéria(s) na grade. Remova os horários primeiro.`
        });
      }
    }

    let newTeacherId = current.assigned_teacher_id;
    if (has('assigned_teacher_id')) {
      newTeacherId = body.assigned_teacher_id ? parseInt(body.assigned_teacher_id) : null;
      if (newTeacherId && newTeacherId !== current.assigned_teacher_id && !(await getActiveProfessor(client, newTeacherId))) {
        return res.status(400).json({ error: 'O professor selecionado não existe ou está inativo.' });
      }
    }

    await client.query('BEGIN');
    const updateRes = await client.query(`
      UPDATE students
      SET name = COALESCE($1, name),
          objective_grade = COALESCE($2, objective_grade),
          start_date = COALESCE($3, start_date),
          end_date = COALESCE($4, end_date),
          status = COALESCE($5, status),
          parent_name = COALESCE($6, parent_name),
          parent_email = COALESCE($7, parent_email),
          parent_phone = COALESCE($8, parent_phone),
          parent_access_code = COALESCE($9, parent_access_code),
          frequency_type = COALESCE($10, frequency_type),
          custom_interval_days = COALESCE($11, custom_interval_days),
          preferred_days = COALESCE($12, preferred_days),
          preferred_time = COALESCE($13, preferred_time),
          duration_minutes = COALESCE($14, duration_minutes),
          enrollment_notes = COALESCE($15, enrollment_notes)
      WHERE id = $16
      RETURNING *
    `, [
      body.name ? body.name.trim() : null,
      body.objective_grade ?? null,
      body.start_date ?? null,
      body.end_date ?? null,
      body.status || null,
      body.parent_name ?? null,
      body.parent_email ?? null,
      body.parent_phone ?? null,
      body.parent_access_code && body.parent_access_code.trim() ? body.parent_access_code.trim().toUpperCase() : null,
      body.frequency_type || null,
      body.custom_interval_days ? parseInt(body.custom_interval_days) : null,
      body.preferred_days || null,
      body.preferred_time || null,
      body.duration_minutes ? parseInt(body.duration_minutes) : null,
      body.enrollment_notes ?? null,
      id
    ]);

    // Dados complementares: aceitam limpar o campo (string vazia vira NULL)
    const extraFields = ['address', 'birth_date', 'school_name', 'school_contact_name', 'school_phone'];
    for (const f of extraFields) {
      if (has(f)) {
        const v = body[f] === null || body[f] === undefined ? null : (String(body[f]).trim() || null);
        await client.query(`UPDATE students SET ${f} = $1 WHERE id = $2`, [v, id]);
      }
    }

    if (Array.isArray(body.subject_ids)) {
      await client.query('DELETE FROM student_subjects WHERE student_id = $1', [id]);
      for (const subId of body.subject_ids) {
        await client.query('INSERT INTO student_subjects (student_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, subId]);
      }
    }

    // Aluno inativado sai da grade
    if (body.status === 'inativo' && current.status !== 'inativo') {
      await client.query(
        "UPDATE teacher_schedules SET status = 'inativo', updated_at = CURRENT_TIMESTAMP WHERE student_id = $1 AND status = 'ativo'",
        [id]
      );
    }

    // Troca ou remoção do professor responsável
    if (has('assigned_teacher_id') && newTeacherId !== current.assigned_teacher_id) {
      const oldTeacherId = current.assigned_teacher_id;
      if (!newTeacherId) {
        // Remover o professor: os horários dele com o aluno saem da grade
        if (oldTeacherId) {
          await client.query(
            "UPDATE teacher_schedules SET status = 'inativo', updated_at = CURRENT_TIMESTAMP WHERE student_id = $1 AND teacher_id = $2 AND status = 'ativo'",
            [id, oldTeacherId]
          );
        }
      } else if (oldTeacherId) {
        // Trocar o professor: se o novo ainda não dá aula ao aluno, os horários do antigo passam para ele
        const newHas = await client.query(
          "SELECT 1 FROM teacher_schedules WHERE student_id = $1 AND teacher_id = $2 AND status = 'ativo'",
          [id, newTeacherId]
        );
        if (newHas.rows.length === 0) {
          const oldSchedules = await client.query(
            "SELECT * FROM teacher_schedules WHERE student_id = $1 AND teacher_id = $2 AND status = 'ativo' ORDER BY id",
            [id, oldTeacherId]
          );
          for (const sched of oldSchedules.rows) {
            const check = await validateScheduleSlot(client, {
              scheduleId: sched.id, teacherId: newTeacherId, studentId: id, subjectId: sched.subject_id,
              classroomId: sched.classroom_id, dayOfWeek: sched.day_of_week, startTime: sched.start_time, endTime: sched.end_time
            });
            if (check.error) {
              await client.query('ROLLBACK');
              return res.status(400).json({ error: `Não foi possível transferir o horário de ${sched.start_time} para o novo professor: ${check.error}` });
            }
            await client.query(
              'UPDATE teacher_schedules SET teacher_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
              [newTeacherId, sched.id]
            );
          }
        }
      }
      await client.query('UPDATE students SET assigned_teacher_id = $1 WHERE id = $2', [newTeacherId, id]);
    }

    if (body.enrollment_status && body.enrollment_status !== current.enrollment_status) {
      await client.query('UPDATE students SET enrollment_status = $1 WHERE id = $2', [body.enrollment_status, id]);
    }
    await syncStudentTeacher(client, id);

    await client.query('COMMIT');
    const finalRes = await pool.query('SELECT * FROM students WHERE id = $1', [id]);
    res.json(finalRes.rows[0] || updateRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Amarrar / Vincular Professor ao Aluno e Gerar Horário na Grade (Exclusivo Administrador)
app.post('/api/students/:id/bind-teacher', authenticateToken, requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const studentId = parseInt(req.params.id);
    const {
      teacher_id, subject_id, day_of_week, start_time, end_time,
      frequency_type, recurrence_interval_days, room_or_info, notes
    } = req.body;

    if (!teacher_id) {
      return res.status(400).json({ error: 'Selecione um professor para vincular ao aluno.' });
    }
    const teacherId = parseInt(teacher_id);
    if (!(await getActiveProfessor(client, teacherId))) {
      return res.status(400).json({ error: 'O professor selecionado não existe ou está inativo.' });
    }
    const freq = frequency_type || 'semanal';
    if (!VALID_FREQUENCIES.includes(freq)) {
      return res.status(400).json({ error: 'Frequência inválida. Use semanal, quinzenal ou custom_dias.' });
    }
    const intervalDays = recurrence_interval_days ? parseInt(recurrence_interval_days) : (freq === 'quinzenal' ? 14 : 7);
    const subId = subject_id ? parseInt(subject_id) : null;
    const wantsSchedule = day_of_week !== undefined && day_of_week !== null && day_of_week !== '' && start_time && end_time;

    let check = null;
    if (wantsSchedule) {
      check = await validateScheduleSlot(client, {
        teacherId, studentId, subjectId: subId,
        dayOfWeek: parseInt(day_of_week), startTime: start_time.trim(), endTime: end_time.trim()
      });
      if (check.error) return res.status(400).json({ error: check.error });
    }

    await client.query('BEGIN');

    const stUpdate = await client.query(`
      UPDATE students
      SET assigned_teacher_id = $1::int,
          enrollment_status = 'ativo',
          frequency_type = COALESCE($2::varchar, frequency_type),
          custom_interval_days = COALESCE($3::int, custom_interval_days),
          preferred_days = COALESCE($4::varchar, preferred_days),
          preferred_time = COALESCE($5::varchar, preferred_time)
      WHERE id = $6::int AND status = 'ativo'
      RETURNING *
    `, [
      teacherId, freq, intervalDays,
      wantsSchedule ? String(day_of_week) : null,
      start_time || null,
      studentId
    ]);

    if (stUpdate.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Aluno não encontrado ou inativo.' });
    }

    let schedule = null;
    if (wantsSchedule) {
      const schedRes = await client.query(`
        INSERT INTO teacher_schedules
          (teacher_id, student_id, subject_id, classroom_id, day_of_week, start_time, end_time, frequency_type, recurrence_interval_days, room_or_info, notes, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ativo')
        RETURNING *
      `, [
        teacherId, studentId, subId, check.classroomId,
        parseInt(day_of_week), start_time.trim(), end_time.trim(), freq, intervalDays,
        room_or_info ? room_or_info.trim() : 'Presencial / Sala de Apoio',
        notes ? notes.trim() : `Aula regular - Aluno(a): ${stUpdate.rows[0].name}`
      ]);
      schedule = schedRes.rows[0];

      if (subId) {
        await client.query(
          'INSERT INTO student_subjects (student_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [studentId, subId]
        );
      }
    }

    await client.query('COMMIT');

    res.json({
      message: wantsSchedule
        ? 'Professor vinculado com sucesso e grade de horário atualizada!'
        : 'Professor vinculado com sucesso! (nenhum horário foi criado na grade)',
      student: stUpdate.rows[0],
      schedule
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Desvincular o professor responsável do aluno (Exclusivo Administrador)
app.post('/api/students/:id/unbind-teacher', authenticateToken, requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const studentId = parseInt(req.params.id);
    const stRes = await client.query('SELECT id, assigned_teacher_id FROM students WHERE id = $1', [studentId]);
    if (stRes.rows.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });
    const oldTeacherId = stRes.rows[0].assigned_teacher_id;

    await client.query('BEGIN');
    let removed = 0;
    if (oldTeacherId) {
      const r = await client.query(
        "UPDATE teacher_schedules SET status = 'inativo', updated_at = CURRENT_TIMESTAMP WHERE student_id = $1 AND teacher_id = $2 AND status = 'ativo'",
        [studentId, oldTeacherId]
      );
      removed = r.rowCount;
    }
    await client.query('UPDATE students SET assigned_teacher_id = NULL WHERE id = $1', [studentId]);
    const synced = await syncStudentTeacher(client, studentId);
    await client.query('COMMIT');

    const message = synced && synced.assigned_teacher_id
      ? `Professor desvinculado (${removed} horário(s) removido(s) da grade). O aluno segue com outro professor que já dava aula para ele.`
      : `Professor desvinculado (${removed} horário(s) removido(s) da grade). O aluno voltou para a fila aguardando professor.`;
    res.json({ message, student: synced });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Excluir Aluno (Exclusivo Administrador). Com histórico (aulas, faturas, tarefas) o aluno é inativado.
app.delete('/api/students/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id);
    const exists = await client.query('SELECT id FROM students WHERE id = $1', [id]);
    if (exists.rows.length === 0) return res.status(404).json({ error: 'Aluno não encontrado' });

    const history = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM class_logs WHERE student_id = $1) as logs,
        (SELECT COUNT(*) FROM invoices WHERE student_id = $1) as invoices,
        (SELECT COUNT(*) FROM student_assignments WHERE student_id = $1) as assignments
    `, [id]);
    const h = history.rows[0];
    const hasHistory = parseInt(h.logs) + parseInt(h.invoices) + parseInt(h.assignments) > 0;

    await client.query('BEGIN');
    if (hasHistory) {
      await client.query("UPDATE students SET status = 'inativo' WHERE id = $1", [id]);
      await client.query(
        "UPDATE teacher_schedules SET status = 'inativo', updated_at = CURRENT_TIMESTAMP WHERE student_id = $1 AND status = 'ativo'",
        [id]
      );
      await client.query('COMMIT');
      return res.json({
        message: `O aluno possui histórico (${h.logs} aula(s), ${h.invoices} fatura(s), ${h.assignments} tarefa(s)). Para preservá-lo, o aluno foi inativado e saiu da grade.`,
        soft_deleted: true
      });
    }

    await client.query('DELETE FROM students WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ message: 'Aluno removido com sucesso' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// MATÉRIAS E TURMAS
// ==========================================
app.get('/api/subjects', optionalAuth, async (req, res) => {
  try {
    const isProf = req.user && req.user.role === 'professor';
    let query;
    let params = [];
    if (isProf) {
      query = `
        SELECT 
          s.*,
          c.name as classroom_name,
          c.type as classroom_type,
          c.resources as classroom_resources,
          COUNT(DISTINCT st.id) as student_count,
          COUNT(DISTINCT cl.id) FILTER (WHERE cl.teacher_id = $1) as total_logs
        FROM subjects s
        LEFT JOIN classrooms c ON c.id = s.classroom_id
        LEFT JOIN student_subjects ss ON ss.subject_id = s.id
        LEFT JOIN students st ON st.id = ss.student_id AND ${teacherStudentsSQL('st', '$1')}
        LEFT JOIN class_logs cl ON cl.subject_id = s.id AND cl.teacher_id = $1
        GROUP BY s.id, c.name, c.type, c.resources
        ORDER BY s.name ASC
      `;
      params = [req.user.id];
    } else {
      query = `
        SELECT 
          s.*,
          c.name as classroom_name,
          c.type as classroom_type,
          c.resources as classroom_resources,
          COUNT(DISTINCT ss.student_id) as student_count,
          COUNT(DISTINCT cl.id) as total_logs
        FROM subjects s
        LEFT JOIN classrooms c ON c.id = s.classroom_id
        LEFT JOIN student_subjects ss ON ss.subject_id = s.id
        LEFT JOIN class_logs cl ON cl.subject_id = s.id
        GROUP BY s.id, c.name, c.type, c.resources
        ORDER BY s.name ASC
      `;
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastrar nova Matéria / Disciplina (Admin)
app.post('/api/subjects', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { 
      name, 
      code, 
      classroom_id, 
      max_students = 4, 
      required_resources = [], 
      total_lessons = 1 
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'O nome da matéria é obrigatório.' });
    }

    const cleanName = name.trim();
    let finalCode = code && code.trim() ? code.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_') : null;

    if (!finalCode) {
      finalCode = cleanName
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      if (!finalCode) finalCode = 'materia_' + Date.now();
    }

    const sameName = await pool.query('SELECT id FROM subjects WHERE LOWER(name) = LOWER($1)', [cleanName]);
    if (sameName.rows.length > 0) {
      return res.status(400).json({ error: `Já existe uma matéria chamada "${cleanName}".` });
    }
    const existingCode = await pool.query('SELECT id FROM subjects WHERE code = $1', [finalCode]);
    if (existingCode.rows.length > 0) {
      if (code && code.trim()) return res.status(400).json({ error: 'Já existe outra matéria cadastrada com este código.' });
      finalCode = `${finalCode}_${Date.now().toString().slice(-4)}`;
    }

    const reqResourcesJson = typeof required_resources === 'string' ? required_resources : JSON.stringify(required_resources);

    const result = await pool.query(
      `INSERT INTO subjects (name, code, classroom_id, max_students, required_resources, total_lessons) 
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) 
       RETURNING *`,
      [
        cleanName, 
        finalCode, 
        classroom_id ? parseInt(classroom_id) : null,
        parseInt(max_students) || 4,
        reqResourcesJson,
        parseInt(total_lessons) || 1
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar Matéria / Disciplina (Admin)
app.put('/api/subjects/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      code, 
      classroom_id, 
      max_students, 
      required_resources, 
      total_lessons 
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'O nome da matéria é obrigatório.' });
    }

    const cleanName = name.trim();
    let cleanCode = code ? code.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_') : null;

    const sameName = await pool.query('SELECT id FROM subjects WHERE LOWER(name) = LOWER($1) AND id <> $2', [cleanName, id]);
    if (sameName.rows.length > 0) {
      return res.status(400).json({ error: `Já existe outra matéria chamada "${cleanName}".` });
    }
    if (max_students !== undefined && max_students !== null && max_students !== '' && !(parseInt(max_students) >= 1)) {
      return res.status(400).json({ error: 'O limite de alunos da matéria deve ser maior que zero.' });
    }

    if (cleanCode) {
      const conflict = await pool.query('SELECT id FROM subjects WHERE code = $1 AND id != $2', [cleanCode, id]);
      if (conflict.rows.length > 0) {
        return res.status(400).json({ error: 'Já existe outra matéria cadastrada com este código.' });
      }
    }

    const reqResourcesJson = required_resources !== undefined 
      ? (typeof required_resources === 'string' ? required_resources : JSON.stringify(required_resources)) 
      : null;

    const updateRes = await pool.query(
      `UPDATE subjects 
       SET name = $1,
           code = COALESCE($2, code),
           classroom_id = CASE WHEN $3::text = 'null' THEN NULL WHEN $3::int IS NOT NULL THEN $3::int ELSE classroom_id END,
           max_students = COALESCE($4, max_students),
           required_resources = CASE WHEN $5::text IS NOT NULL THEN $5::jsonb ELSE required_resources END,
           total_lessons = COALESCE($6, total_lessons)
       WHERE id = $7
       RETURNING *`,
      [
        cleanName, 
        cleanCode, 
        classroom_id !== undefined ? (classroom_id === null ? 'null' : parseInt(classroom_id)) : null,
        max_students ? parseInt(max_students) : null,
        reqResourcesJson,
        total_lessons ? parseInt(total_lessons) : null,
        id
      ]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: 'Matéria não encontrada.' });
    }

    res.json({ message: 'Matéria atualizada com sucesso!', subject: updateRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excluir Matéria / Disciplina (Admin)
app.delete('/api/subjects/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Verifica se possui aulas lançadas
    const logsCheck = await pool.query('SELECT COUNT(*) FROM class_logs WHERE subject_id = $1', [id]);
    const totalLogs = parseInt(logsCheck.rows[0].count);

    if (totalLogs > 0) {
      return res.status(400).json({
        error: `Não é possível excluir esta matéria pois ela possui ${totalLogs} aula(s) registrada(s) no diário de classe. Para preservar o histórico pedagógico dos alunos, a exclusão foi impedida.`
      });
    }

    const schedCheck = await pool.query("SELECT COUNT(*) FROM teacher_schedules WHERE subject_id = $1 AND status = 'ativo'", [id]);
    const totalSched = parseInt(schedCheck.rows[0].count);
    if (totalSched > 0) {
      return res.status(400).json({
        error: `Não é possível excluir esta matéria pois ela possui ${totalSched} aula(s) ativa(s) na grade de horários. Remova os horários primeiro.`
      });
    }

    // Exclui relacionamentos associados
    await pool.query('DELETE FROM student_subjects WHERE subject_id = $1', [id]);
    await pool.query('DELETE FROM teacher_subjects WHERE subject_id = $1', [id]);
    await pool.query('DELETE FROM teacher_schedules WHERE subject_id = $1', [id]);

    const delRes = await pool.query('DELETE FROM subjects WHERE id = $1 RETURNING *', [id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ error: 'Matéria não encontrada.' });
    }

    res.json({ message: 'Matéria excluída com sucesso!', deleted: delRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// SALAS DE AULA & RECURSOS PEDAGÓGICOS
// ==========================================

// Helper para normalizar lista de recursos (seja array de strings ou de objetos)
function normalizeClassroomResources(res) {
  if (!Array.isArray(res)) return [];
  return res.map(r => {
    if (!r) return '';
    if (typeof r === 'string') return r.trim();
    if (typeof r === 'object' && r && r.name) return String(r.name).trim();
    return String(r).trim();
  }).filter(Boolean);
}

// Listar todas as salas ativas com dados de ocupação
app.get('/api/classrooms', optionalAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.*,
        (SELECT COUNT(*) FROM subjects sub WHERE sub.classroom_id = c.id) as total_subjects_linked,
        (SELECT COUNT(DISTINCT ts.id) FROM teacher_schedules ts WHERE ts.classroom_id = c.id AND ts.status = 'ativo') as active_schedules_count
      FROM classrooms c
      WHERE c.status = 'ativo'
      ORDER BY c.type ASC, c.id ASC
    `);

    const formatted = result.rows.map(row => ({
      ...row,
      resources: normalizeClassroomResources(row.resources)
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar salas: ' + err.message });
  }
});

// Detalhes de uma sala específica
app.get('/api/classrooms/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM classrooms WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sala não encontrada.' });
    }
    const classroom = {
      ...result.rows[0],
      resources: normalizeClassroomResources(result.rows[0].resources)
    };

    const subjectsRes = await pool.query(`
      SELECT id, code, name, max_students, required_resources 
      FROM subjects 
      WHERE classroom_id = $1
    `, [id]);

    const schedulesRes = await pool.query(`
      SELECT ts.id, ts.day_of_week, ts.start_time, ts.end_time, ts.frequency_type,
             u.name as teacher_name, sub.name as subject_name, st.name as student_name
      FROM teacher_schedules ts
      JOIN users u ON u.id = ts.teacher_id
      LEFT JOIN subjects sub ON sub.id = ts.subject_id
      LEFT JOIN students st ON st.id = ts.student_id
      WHERE ts.classroom_id = $1 AND ts.status = 'ativo'
      ORDER BY ts.day_of_week ASC, ts.start_time ASC
    `, [id]);

    res.json({
      classroom,
      subjects: subjectsRes.rows,
      schedules: schedulesRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastrar Nova Sala (Exclusivo Administrador)
app.post('/api/classrooms', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { 
      name, 
      type = 'presencial', 
      capacity_students = 4, 
      capacity_teachers = 1, 
      resources = [], 
      description = '' 
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'O nome da sala é obrigatório.' });
    }

    const resourcesJson = typeof resources === 'string' ? resources : JSON.stringify(resources);

    const result = await pool.query(`
      INSERT INTO classrooms 
        (name, type, capacity_students, capacity_teachers, resources, description, status)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'ativo')
      RETURNING *
    `, [
      name.trim(),
      type === 'online' ? 'online' : 'presencial',
      parseInt(capacity_students) || 4,
      parseInt(capacity_teachers) || 1,
      resourcesJson,
      description ? description.trim() : null
    ]);

    res.status(201).json({
      message: 'Sala cadastrada com sucesso!',
      classroom: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar Sala (Exclusivo Administrador)
app.put('/api/classrooms/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      type, 
      capacity_students, 
      capacity_teachers, 
      resources, 
      description,
      status 
    } = req.body;

    const resourcesJson = resources !== undefined 
      ? (typeof resources === 'string' ? resources : JSON.stringify(resources))
      : null;

    const result = await pool.query(`
      UPDATE classrooms
      SET name = COALESCE($1, name),
          type = COALESCE($2, type),
          capacity_students = COALESCE($3, capacity_students),
          capacity_teachers = COALESCE($4, capacity_teachers),
          resources = CASE WHEN $5::text IS NOT NULL THEN $5::jsonb ELSE resources END,
          description = COALESCE($6, description),
          status = COALESCE($7, status),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `, [
      name ? name.trim() : null,
      type || null,
      capacity_students ? parseInt(capacity_students) : null,
      capacity_teachers ? parseInt(capacity_teachers) : null,
      resourcesJson,
      description !== undefined && description !== null ? String(description).trim() : null,
      status || null,
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sala não encontrada.' });
    }

    res.json({
      message: 'Sala atualizada com sucesso!',
      classroom: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excluir Sala (Exclusivo Administrador)
app.delete('/api/classrooms/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const schedCount = await pool.query('SELECT COUNT(*) FROM teacher_schedules WHERE classroom_id = $1 AND status = \'ativo\'', [id]);
    if (parseInt(schedCount.rows[0].count) > 0) {
      return res.status(400).json({
        error: `Não é possível excluir esta sala pois ela possui ${schedCount.rows[0].count} aula(s) ativa(s) agendada(s). Desvincule ou remova as aulas primeiro.`
      });
    }

    const result = await pool.query('DELETE FROM classrooms WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sala não encontrada.' });
    }

    res.json({ message: 'Sala excluída com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// REGISTROS DE AULA (DIÁRIO DE CLASSE)
// ==========================================

// Listar Aulas (professor: só as que ele lançou; família: só as do próprio aluno)
app.get('/api/logs', authenticateToken, async (req, res) => {
  try {
    const { student_id, subject_id, teacher_id, limit = 50 } = req.query;
    let query = `
      SELECT
        cl.*,
        st.name as student_name,
        sub.name as subject_name,
        c.name as classroom_name,
        c.type as classroom_type,
        COALESCE(u.name, cl.teacher_name) as teacher_display_name,
        to_char(cl.class_date, 'DD/MM/YYYY') as class_date_br,
        COALESCE(cl.class_time, to_char(cl.created_at AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI')) as class_time_display,
        to_char(cl.class_date, 'DD/MM/YYYY') || ' - ' ||
        COALESCE(
          CASE
            WHEN cl.class_time IS NOT NULL AND cl.class_time != ''
            THEN replace(substring(cl.class_time from 1 for 5), ':', 'h') || 'm'
            ELSE to_char(cl.created_at AT TIME ZONE 'America/Sao_Paulo', 'HH24"h"MI"m"')
          END,
          '07h30m'
        ) as formatted_date_time
      FROM class_logs cl
      JOIN students st ON st.id = cl.student_id
      JOIN subjects sub ON sub.id = cl.subject_id
      LEFT JOIN classrooms c ON c.id = cl.classroom_id
      LEFT JOIN users u ON u.id = cl.teacher_id
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role === 'professor') {
      params.push(req.user.id);
      query += ` AND cl.teacher_id = $${params.length}`;
    } else if (req.user.role === 'responsavel') {
      params.push(req.user.student_id);
      query += ` AND cl.student_id = $${params.length}`;
    } else if (teacher_id) {
      params.push(teacher_id);
      query += ` AND cl.teacher_id = $${params.length}`;
    }

    if (student_id) {
      params.push(student_id);
      query += ` AND cl.student_id = $${params.length}`;
    }
    if (subject_id) {
      params.push(subject_id);
      query += ` AND cl.subject_id = $${params.length}`;
    }

    params.push(Math.min(Math.max(parseInt(limit) || 50, 1), 1000));
    query += ` ORDER BY cl.class_date DESC, cl.id DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Regras do diário: presença válida, data não futura, horário HH:MM, aluno matriculado na
 * matéria, professor vinculado ao aluno e à matéria, e um lançamento por aluno/matéria/dia.
 * Retorna mensagem de erro ou null.
 */
async function validateClassLog(req, { logId = null, studentId, subjectId, classDate, classTime, status }) {
  if (status !== undefined && !VALID_LOG_STATUS.includes(status)) {
    return 'Frequência inválida. Use "presente" ou "falta".';
  }
  if (classTime && !TIME_RE.test(classTime)) return 'Horário da aula deve estar no formato HH:MM.';
  if (classDate !== undefined) {
    const iso = toISODate(classDate);
    if (!iso) return 'Data da aula inválida.';
    if (iso > getSaoPauloNow().dateStr) return 'Não é possível registrar aula em data futura.';
  }

  const stRes = await pool.query('SELECT id, name FROM students WHERE id = $1', [studentId]);
  if (stRes.rows.length === 0) return 'Aluno não encontrado.';
  const subRes = await pool.query('SELECT id, name FROM subjects WHERE id = $1', [subjectId]);
  if (subRes.rows.length === 0) return 'Matéria não encontrada.';

  const enrolled = await pool.query('SELECT 1 FROM student_subjects WHERE student_id = $1 AND subject_id = $2', [studentId, subjectId]);
  if (enrolled.rows.length === 0) {
    return `${stRes.rows[0].name} não está matriculado(a) em ${subRes.rows[0].name}.`;
  }

  if (req.user.role === 'professor') {
    if (!(await teacherCanAccessStudent(req.user.id, studentId))) {
      return 'Acesso negado: este aluno não está vinculado a você.';
    }
    const allowed = await pool.query(`
      SELECT 1 FROM teacher_subjects WHERE user_id = $1 AND subject_id = $2
      UNION
      SELECT 1 FROM teacher_schedules WHERE teacher_id = $1 AND subject_id = $2 AND student_id = $3 AND status = 'ativo'
    `, [req.user.id, subjectId, studentId]);
    if (allowed.rows.length === 0) {
      return `Você não leciona ${subRes.rows[0].name} para este aluno.`;
    }
  }

  if (classDate !== undefined) {
    const dup = await pool.query(`
      SELECT id FROM class_logs
      WHERE student_id = $1 AND subject_id = $2 AND class_date = $3::date AND ($4::int IS NULL OR id <> $4)
      LIMIT 1
    `, [studentId, subjectId, toISODate(classDate), logId]);
    if (dup.rows.length > 0) {
      return 'Já existe um lançamento deste aluno nesta matéria para esta data. Edite o registro existente.';
    }
  }
  return null;
}

// Criar Registro de Aula (DIÁRIO DE CLASSE)
app.post('/api/logs', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    let {
      student_id,
      subject_id,
      classroom_id,
      resources_used = [],
      class_date,
      class_time,
      status = 'presente',
      content = '',
      incidents = 'Sem intercorrências',
      pedagogical_notes = ''
    } = req.body;

    if (!student_id || !subject_id) {
      return res.status(400).json({ error: 'student_id e subject_id são obrigatórios' });
    }

    const spNow = getSaoPauloNow();
    const dateVal = toISODate(class_date) || (class_date ? null : spNow.dateStr);
    if (!dateVal) return res.status(400).json({ error: 'Data da aula inválida.' });
    const timeVal = class_time || spNow.timeStr;

    const validationError = await validateClassLog(req, {
      studentId: parseInt(student_id), subjectId: parseInt(subject_id),
      classDate: dateVal, classTime: timeVal, status
    });
    if (validationError) {
      const code = validationError.startsWith('Acesso negado') ? 403 : (validationError.startsWith('Já existe') ? 409 : 400);
      return res.status(code).json({ error: validationError });
    }

    // Se não informou sala, herda da matéria
    if (!classroom_id) {
      const subRes = await pool.query('SELECT classroom_id FROM subjects WHERE id = $1', [subject_id]);
      if (subRes.rows.length > 0 && subRes.rows[0].classroom_id) {
        classroom_id = subRes.rows[0].classroom_id;
      }
    }

    const resourcesUsedJson = typeof resources_used === 'string' ? resources_used : JSON.stringify(resources_used);

    const result = await pool.query(`
      INSERT INTO class_logs
        (student_id, subject_id, classroom_id, resources_used, teacher_id, class_date, class_time, status, content, incidents, pedagogical_notes, teacher_name)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *,
        to_char(class_date, 'DD/MM/YYYY') as class_date_br,
        COALESCE(class_time, $7) as class_time_display,
        to_char(class_date, 'DD/MM/YYYY') || ' - ' ||
        CASE
          WHEN class_time IS NOT NULL AND class_time != ''
          THEN replace(substring(class_time from 1 for 5), ':', 'h') || 'm'
          ELSE '07h30m'
        END as formatted_date_time
    `, [
      student_id,
      subject_id,
      classroom_id ? parseInt(classroom_id) : null,
      resourcesUsedJson,
      req.user.id,
      dateVal,
      timeVal,
      status,
      content,
      incidents,
      pedagogical_notes,
      req.user.name
    ]);

    res.status(201).json({
      message: 'Registro de aula salvo com sucesso no PostgreSQL!',
      log: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar Registro de Aula (Próprio autor ou Admin)
app.put('/api/logs/:id', authenticateToken, ensureOwnLogOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      class_date,
      class_time,
      status,
      content,
      incidents,
      pedagogical_notes,
      classroom_id,
      resources_used
    } = req.body;

    const currentRes = await pool.query('SELECT * FROM class_logs WHERE id = $1', [id]);
    const current = currentRes.rows[0];
    if (!current) return res.status(404).json({ error: 'Registro não encontrado' });

    const newDate = class_date ? toISODate(class_date) : undefined;
    if (class_date && !newDate) return res.status(400).json({ error: 'Data da aula inválida.' });

    const validationError = await validateClassLog(req, {
      logId: parseInt(id),
      studentId: current.student_id,
      subjectId: current.subject_id,
      classDate: newDate,
      classTime: class_time || null,
      status
    });
    if (validationError) {
      const code = validationError.startsWith('Acesso negado') ? 403 : (validationError.startsWith('Já existe') ? 409 : 400);
      return res.status(code).json({ error: validationError });
    }

    const resourcesUsedJson = resources_used !== undefined
      ? (typeof resources_used === 'string' ? resources_used : JSON.stringify(resources_used))
      : null;

    const result = await pool.query(`
      UPDATE class_logs
      SET class_date = COALESCE($1, class_date),
          class_time = COALESCE($2, class_time),
          status = COALESCE($3, status),
          content = COALESCE($4, content),
          incidents = COALESCE($5, incidents),
          pedagogical_notes = COALESCE($6, pedagogical_notes),
          classroom_id = CASE WHEN $7::text = 'null' THEN NULL WHEN $7::int IS NOT NULL THEN $7::int ELSE classroom_id END,
          resources_used = CASE WHEN $8::text IS NOT NULL THEN $8::jsonb ELSE resources_used END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING *
    `, [
      newDate || null,
      class_time || null,
      status || null,
      content ?? null,
      incidents ?? null,
      pedagogical_notes ?? null,
      classroom_id !== undefined ? (classroom_id === null ? 'null' : parseInt(classroom_id)) : null,
      resourcesUsedJson,
      id
    ]);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deletar Registro de Aula (Próprio autor ou Admin)
app.delete('/api/logs/:id', authenticateToken, ensureOwnLogOrAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM class_logs WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Registro não encontrado' });
    }
    res.json({ message: 'Registro excluído com sucesso' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// DASHBOARD & ESTATÍSTICAS
// ==========================================
app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'professor') {
      const profStats = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM students st WHERE st.status = 'ativo' AND ${teacherStudentsSQL('st', '$1')}) as total_students,
          1 as total_teachers,
          (SELECT COUNT(DISTINCT subject_id) FROM teacher_subjects WHERE user_id = $1) as total_subjects,
          COUNT(cl.id) as total_logs,
          COUNT(CASE WHEN cl.status = 'presente' THEN 1 END) as total_presences,
          COUNT(CASE WHEN cl.status = 'falta' THEN 1 END) as total_absences
        FROM class_logs cl
        WHERE cl.teacher_id = $1
      `, [req.user.id]);
      const bdays = await pool.query(`
        SELECT id, name,
               to_char(birth_date, 'YYYY-MM-DD') as birth_date,
               to_char(birth_date, 'DD/MM') as birthday_br,
               EXTRACT(DAY FROM birth_date)::int as birth_day,
               school_name
        FROM students st
        WHERE st.status = 'ativo'
          AND st.birth_date IS NOT NULL
          AND EXTRACT(MONTH FROM st.birth_date) = EXTRACT(MONTH FROM CURRENT_DATE)
          AND ${teacherStudentsSQL('st', '$1')}
        ORDER BY EXTRACT(DAY FROM st.birth_date) ASC, st.name ASC
      `, [req.user.id]);
      const data = profStats.rows[0];
      data.birthdays = bdays.rows;
      return res.json(data);
    }

    if (req.user.role === 'responsavel') {
      const famStats = await pool.query(`
        SELECT
          1 as total_students,
          (SELECT COUNT(DISTINCT teacher_id) FROM teacher_schedules WHERE student_id = $1 AND status = 'ativo') as total_teachers,
          (SELECT COUNT(*) FROM student_subjects WHERE student_id = $1) as total_subjects,
          COUNT(cl.id) as total_logs,
          COUNT(CASE WHEN cl.status = 'presente' THEN 1 END) as total_presences,
          COUNT(CASE WHEN cl.status = 'falta' THEN 1 END) as total_absences
        FROM class_logs cl
        WHERE cl.student_id = $1
      `, [req.user.student_id]);
      const data = famStats.rows[0];
      data.birthdays = [];
      return res.json(data);
    }

    const statsQuery = `
      SELECT
        (SELECT COUNT(*) FROM students WHERE status = 'ativo') as total_students,
        (SELECT COUNT(*) FROM users WHERE role = 'professor' AND status = 'ativo') as total_teachers,
        (SELECT COUNT(*) FROM subjects) as total_subjects,
        (SELECT COUNT(*) FROM class_logs) as total_logs,
        (SELECT COUNT(*) FROM class_logs WHERE status = 'presente') as total_presences,
        (SELECT COUNT(*) FROM class_logs WHERE status = 'falta') as total_absences
    `;
    const result = await pool.query(statsQuery);
    const bdays = await pool.query(`
      SELECT id, name,
             to_char(birth_date, 'YYYY-MM-DD') as birth_date,
             to_char(birth_date, 'DD/MM') as birthday_br,
             EXTRACT(DAY FROM birth_date)::int as birth_day,
             school_name
      FROM students
      WHERE status = 'ativo'
        AND birth_date IS NOT NULL
        AND EXTRACT(MONTH FROM birth_date) = EXTRACT(MONTH FROM CURRENT_DATE)
      ORDER BY EXTRACT(DAY FROM birth_date) ASC, name ASC
    `);
    const data = result.rows[0];
    data.birthdays = bdays.rows;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// TELA "HOJE" DO PROFESSOR (AULAS DO DIA)
// ==========================================
app.get('/api/teacher/today-classes', authenticateToken, requireRole('professor', 'admin'), async (req, res) => {
  try {
    const teacherId = req.query.teacher_id && req.user.role === 'admin'
      ? parseInt(req.query.teacher_id)
      : req.user.id;

    const spNow = getSaoPauloNow();
    const todayIso = spNow.dateStr;
    const tomorrowIso = new Date(isoToUTC(todayIso) + 86400000).toISOString().slice(0, 10);
    const todayDayOfWeek = weekdayOf(todayIso);
    const tomorrowDayOfWeek = weekdayOf(tomorrowIso);

    const dayNames = {
      0: 'Domingo',
      1: 'Segunda-feira',
      2: 'Terça-feira',
      3: 'Quarta-feira',
      4: 'Quinta-feira',
      5: 'Sexta-feira',
      6: 'Sábado'
    };

    // Todos os horários ativos do professor; a recorrência (semanal, quinzenal, a cada N dias)
    // é resolvida em isScheduleOnDate, a mesma regra usada pelo calendário do front.
    const schedulesRes = await pool.query(`
      SELECT DISTINCT ON (ts.id)
        ts.id as schedule_id,
        ts.day_of_week,
        ts.start_time,
        ts.end_time,
        ts.room_or_info,
        ts.notes as schedule_notes,
        ts.frequency_type,
        ts.recurrence_interval_days,
        ts.start_date,
        ts.end_date,
        ts.created_at,
        st.id as student_id,
        COALESCE(st.name, ts.room_or_info, 'Aula de Apoio / Turma') as student_name,
        st.objective_grade as student_objective_grade,
        st.status as student_status,
        st.frequency_type as student_frequency_type,
        st.custom_interval_days as student_custom_interval_days,
        st.start_date as student_start_date,
        sub.id as subject_id,
        sub.name as subject_name,
        sub.code as subject_code,
        sub.required_resources,
        sub.max_students,
        clr.id as classroom_id,
        clr.name as classroom_name,
        clr.type as classroom_type,
        clr.resources as classroom_resources,
        cl.id as log_id,
        cl.status as log_status,
        cl.content as log_content,
        cl.class_time as log_class_time,
        cl.pedagogical_notes as log_pedagogical_notes,
        cl.resources_used as log_resources_used
      FROM teacher_schedules ts
      LEFT JOIN students st ON st.id = ts.student_id
      LEFT JOIN subjects sub ON sub.id = ts.subject_id
      LEFT JOIN classrooms clr ON clr.id = COALESCE(ts.classroom_id, sub.classroom_id)
      LEFT JOIN class_logs cl ON cl.student_id = ts.student_id
                             AND (cl.subject_id = ts.subject_id OR ts.subject_id IS NULL)
                             AND cl.class_date = $1::date
      WHERE ts.teacher_id = $2
        AND ts.status = 'ativo'
        AND (st.id IS NULL OR st.status = 'ativo')
      ORDER BY ts.id, cl.id DESC
    `, [todayIso, teacherId]);

    const activeTodayRows = schedulesRes.rows
      .filter(row => isScheduleOnDate(row, todayIso))
      .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || '') || (a.student_name || '').localeCompare(b.student_name || ''));

    const tomorrowCount = schedulesRes.rows.filter(row => isScheduleOnDate(row, tomorrowIso)).length;

    const formattedClasses = activeTodayRows.map(row => {
      const isRegistered = Boolean(row.log_id);
      return {
        schedule_id: row.schedule_id,
        student_id: row.student_id,
        student_name: row.student_name,
        student_objective_grade: row.student_objective_grade,
        subject_id: row.subject_id,
        subject_name: row.subject_name || 'Geral / Reforço',
        subject_code: row.subject_code,
        start_time: row.start_time,
        end_time: row.end_time,
        time_display: `${row.start_time} - ${row.end_time}`,
        frequency_type: row.frequency_type || row.student_frequency_type || 'semanal',
        room_or_info: row.classroom_name || row.room_or_info || 'Sala Presencial / Apoio',
        classroom_id: row.classroom_id || null,
        classroom_name: row.classroom_name || null,
        classroom_type: row.classroom_type || 'presencial',
        classroom_resources: row.classroom_resources || [],
        required_resources: row.required_resources || [],
        status: isRegistered ? 'registrado' : 'pendente',
        log_id: row.log_id || null,
        log_status: row.log_status || null,
        log_content: row.log_content || null,
        log_resources_used: row.log_resources_used || []
      };
    });

    const pendingCount = formattedClasses.filter(c => c.status === 'pendente').length;
    const registeredCount = formattedClasses.filter(c => c.status === 'registrado').length;

    res.json({
      date_str: todayIso,
      date_br: formatBRDateTime(todayIso, '').split(' - ')[0],
      day_of_week: todayDayOfWeek,
      day_name: dayNames[todayDayOfWeek],
      total_today: formattedClasses.length,
      pending_count: pendingCount,
      registered_count: registeredCount,
      tomorrow_count: tomorrowCount,
      tomorrow_day_name: dayNames[tomorrowDayOfWeek],
      classes: formattedClasses
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar aulas de hoje: ' + err.message });
  }
});

// ==========================================
// PAINEL DE CONTROLE DO ADMIN (DASHBOARD & PENDÊNCIAS)
// ==========================================
app.get('/api/admin/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // 1. Alunos aguardando professor
    const unassignedStudentsRes = await pool.query(`
      SELECT 
        st.id, st.name, st.objective_grade, st.preferred_days, st.preferred_time, 
        st.frequency_type, st.created_at,
        to_char(st.created_at, 'DD/MM/YYYY') as created_at_br,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', sub.id, 'name', sub.name, 'code', sub.code)) 
          FILTER (WHERE sub.id IS NOT NULL), '[]'
        ) as subjects
      FROM students st
      LEFT JOIN student_subjects ss ON ss.student_id = st.id
      LEFT JOIN subjects sub ON sub.id = ss.subject_id
      WHERE (st.enrollment_status = 'aguardando_professor' OR st.assigned_teacher_id IS NULL)
        AND st.status = 'ativo'
      GROUP BY st.id
      ORDER BY st.id DESC
    `);

    // 2. Recados pendentes de leitura há +3 dias
    const unreadAgendaRes = await pool.query(`
      SELECT 
        sa.id, sa.title, sa.category, sa.entry_date, sa.is_important,
        to_char(sa.entry_date, 'DD/MM/YYYY') as entry_date_br,
        CURRENT_DATE - sa.entry_date as days_pending,
        st.id as student_id, st.name as student_name,
        u.name as author_name
      FROM student_agenda sa
      JOIN students st ON st.id = sa.student_id
      LEFT JOIN users u ON u.id = sa.author_id
      WHERE sa.read_by_parent = false
        AND sa.entry_date <= (CURRENT_DATE - INTERVAL '3 days')
      ORDER BY sa.entry_date ASC
      LIMIT 10
    `);

    // 3. Alunos com baixa frequência (< 75% nos últimos 30 dias com pelo menos 2 aulas)
    const lowAttendanceRes = await pool.query(`
      WITH student_recent_logs AS (
        SELECT 
          cl.student_id,
          COUNT(cl.id) as total,
          COUNT(cl.id) FILTER (WHERE cl.status = 'presente') as presences,
          COUNT(cl.id) FILTER (WHERE cl.status = 'falta') as absences
        FROM class_logs cl
        WHERE cl.class_date >= (CURRENT_DATE - INTERVAL '30 days')
        GROUP BY cl.student_id
        HAVING COUNT(cl.id) >= 2
      )
      SELECT 
        st.id, st.name, st.objective_grade,
        srl.total, srl.presences, srl.absences,
        ROUND((srl.presences::decimal / srl.total::decimal) * 100, 1) as rate,
        u.name as teacher_name
      FROM student_recent_logs srl
      JOIN students st ON st.id = srl.student_id
      LEFT JOIN users u ON u.id = st.assigned_teacher_id
      WHERE (srl.presences::decimal / srl.total::decimal) < 0.75
        AND st.status = 'ativo'
      ORDER BY rate ASC
      LIMIT 10
    `);

    // 4. Professores inativos (sem lançamentos nos últimos 7 dias)
    const inactiveTeachersRes = await pool.query(`
      SELECT 
        u.id, u.name, u.email,
        MAX(cl.class_date) as last_class_date,
        to_char(MAX(cl.class_date), 'DD/MM/YYYY') as last_class_date_br,
        CURRENT_DATE - MAX(cl.class_date) as days_since_last_class
      FROM users u
      LEFT JOIN class_logs cl ON cl.teacher_id = u.id
      WHERE u.role = 'professor' AND u.status = 'ativo'
      GROUP BY u.id
      HAVING MAX(cl.class_date) IS NULL OR MAX(cl.class_date) < (CURRENT_DATE - INTERVAL '7 days')
      ORDER BY last_class_date ASC NULLS FIRST
    `);

    // 5. KPIs da escola
    const kpisRes = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM students WHERE status = 'ativo') as total_students,
        (SELECT COUNT(*) FROM users WHERE role = 'professor' AND status = 'ativo') as total_teachers,
        (SELECT COUNT(*) FROM subjects) as total_subjects,
        (SELECT COUNT(*) FROM class_logs WHERE date_trunc('month', class_date) = date_trunc('month', CURRENT_DATE)) as month_classes,
        (SELECT COUNT(*) FROM class_logs) as total_classes_all_time,
        (SELECT ROUND(AVG(CASE WHEN status = 'presente' THEN 100.0 ELSE 0.0 END), 1) FROM class_logs WHERE class_date >= CURRENT_DATE - INTERVAL '30 days') as avg_attendance_rate
    `);

    res.json({
      kpis: kpisRes.rows[0],
      pending: {
        students_without_teacher: unassignedStudentsRes.rows,
        unread_agenda_3d: unreadAgendaRes.rows,
        low_attendance_students: lowAttendanceRes.rows,
        inactive_teachers: inactiveTeachersRes.rows
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar métricas do painel: ' + err.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const dbRes = await pool.query('SELECT NOW() as current_time');
    res.json({
      status: 'ok',
      db: 'connected',
      time: dbRes.rows[0].current_time
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ==========================================
// ROTAS DE RELATÓRIOS DO ADMINISTRADOR
// ==========================================

// 1. Relatório consolidado de todos os alunos (Overview)
app.get('/api/reports/overview', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.user.role === 'professor') {
      params.push(req.user.id);
      where = `WHERE ${teacherStudentsSQL('st', '$1')}`;
    }
    const query = `
      SELECT 
        st.id,
        st.name,
        st.objective_grade,
        st.start_date,
        st.status,
        lg.total_classes,
        lg.total_presences,
        lg.total_absences,
        ROUND(
          CASE 
            WHEN lg.total_classes > 0 
            THEN (lg.total_presences::decimal / lg.total_classes::decimal) * 100 
            ELSE 100 
          END, 1
        ) as attendance_rate,
        lg.last_class_date,
        COALESCE((
          SELECT json_agg(jsonb_build_object('id', sub.id, 'name', sub.name, 'code', sub.code) ORDER BY sub.name)
          FROM student_subjects ss JOIN subjects sub ON sub.id = ss.subject_id
          WHERE ss.student_id = st.id
        ), '[]') as subjects
      FROM students st
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) as total_classes,
          COUNT(*) FILTER (WHERE cl.status = 'presente') as total_presences,
          COUNT(*) FILTER (WHERE cl.status = 'falta') as total_absences,
          MAX(cl.class_date) as last_class_date
        FROM class_logs cl
        WHERE cl.student_id = st.id
      ) lg ON true
      ${where}
      ORDER BY st.name ASC
    `;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Relatório individual detalhado do aluno (Dia a Dia)
app.get('/api/reports/student/:id', authenticateToken, async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.params.id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const id = scope.studentId;
    const { subject_id, start_date, end_date, order = 'asc' } = req.query;

    // Busca dados do aluno
    const studentRes = await pool.query(`
      SELECT 
        st.*,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', sub.id, 'name', sub.name, 'code', sub.code)) 
          FILTER (WHERE sub.id IS NOT NULL), '[]'
        ) as subjects
      FROM students st
      LEFT JOIN student_subjects ss ON ss.student_id = st.id
      LEFT JOIN subjects sub ON sub.id = ss.subject_id
      WHERE st.id = $1
      GROUP BY st.id
    `, [id]);

    if (studentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado' });
    }

    const student = studentRes.rows[0];

    // Consulta de registros dia a dia com filtros
    let logsQuery = `
      SELECT 
        cl.*,
        sub.name as subject_name,
        sub.code as subject_code,
        COALESCE(u.name, cl.teacher_name, 'Professor') as teacher_display_name,
        to_char(cl.class_date, 'DD/MM/YYYY') as class_date_br,
        COALESCE(cl.class_time, to_char(cl.created_at AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI')) as class_time_display,
        to_char(cl.class_date, 'DD/MM/YYYY') || ' - ' || 
        COALESCE(
          CASE 
            WHEN cl.class_time IS NOT NULL AND cl.class_time != ''
            THEN replace(substring(cl.class_time from 1 for 5), ':', 'h') || 'm'
            ELSE to_char(cl.created_at AT TIME ZONE 'America/Sao_Paulo', 'HH24"h"MI"m"')
          END,
          '07h30m'
        ) as formatted_date_time
      FROM class_logs cl
      JOIN subjects sub ON sub.id = cl.subject_id
      LEFT JOIN users u ON u.id = cl.teacher_id
      WHERE cl.student_id = $1
    `;
    const params = [id];

    if (subject_id) {
      params.push(subject_id);
      logsQuery += ` AND cl.subject_id = $${params.length}`;
    }

    if (start_date) {
      params.push(start_date);
      logsQuery += ` AND cl.class_date >= $${params.length}`;
    }

    if (end_date) {
      params.push(end_date);
      logsQuery += ` AND cl.class_date <= $${params.length}`;
    }

    const sortOrder = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    logsQuery += ` ORDER BY cl.class_date ${sortOrder}, cl.id ${sortOrder}`;

    const logsRes = await pool.query(logsQuery, params);
    const logs = logsRes.rows;

    const totalClasses = logs.length;
    const totalPresences = logs.filter(l => l.status === 'presente').length;
    const totalAbsences = logs.filter(l => l.status === 'falta').length;
    const attendanceRate = totalClasses > 0 ? Math.round((totalPresences / totalClasses) * 1000) / 10 : 100;

    const subjectStats = {};
    logs.forEach(l => {
      if (!subjectStats[l.subject_name]) {
        subjectStats[l.subject_name] = { total: 0, presences: 0, absences: 0 };
      }
      subjectStats[l.subject_name].total++;
      if (l.status === 'presente') subjectStats[l.subject_name].presences++;
      else subjectStats[l.subject_name].absences++;
    });

    const nowParts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const dtMap = {};
    nowParts.forEach(p => dtMap[p.type] = p.value);
    const emissionDateTime = `${dtMap.day}/${dtMap.month}/${dtMap.year} - ${dtMap.hour}h${dtMap.minute}m`;

    res.json({
      student,
      emission_date_time: emissionDateTime,
      stats: {
        total_classes: totalClasses,
        total_presences: totalPresences,
        total_absences: totalAbsences,
        attendance_rate: attendanceRate,
        subjects_breakdown: subjectStats
      },
      logs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROTAS DE GRADE DE HORÁRIOS DOS PROFESSORES
// ==========================================

// Listar Horários (Acesso visual para Professores e Administradores, compatível com Google Calendar)
app.get('/api/schedules', authenticateToken, async (req, res) => {
  try {
    const { teacher_id, student_id, classroom_id, day_of_week, frequency_type } = req.query;
    let query = `
      SELECT 
        ts.*,
        u.name as teacher_name,
        u.email as teacher_email,
        sub.name as subject_name,
        sub.code as subject_code,
        sub.max_students as subject_max_students,
        sub.required_resources as subject_required_resources,
        clr.name as classroom_name,
        clr.type as classroom_type,
        clr.capacity_students as classroom_capacity_students,
        clr.capacity_teachers as classroom_capacity_teachers,
        clr.resources as classroom_resources,
        st.name as student_name,
        st.objective_grade as student_objective_grade,
        st.enrollment_status as student_enrollment_status,
        st.parent_name as student_parent_name,
        st.parent_phone as student_parent_phone,
        COALESCE(ts.frequency_type, st.frequency_type, 'semanal') as resolved_frequency,
        COALESCE(ts.recurrence_interval_days, st.custom_interval_days, 7) as resolved_interval_days
      FROM teacher_schedules ts
      JOIN users u ON u.id = ts.teacher_id
      LEFT JOIN subjects sub ON sub.id = ts.subject_id
      LEFT JOIN classrooms clr ON clr.id = COALESCE(ts.classroom_id, sub.classroom_id)
      LEFT JOIN students st ON st.id = ts.student_id
      WHERE ts.status = 'ativo'
    `;
    const params = [];

    // Professor vê a própria grade; família vê só os horários do próprio aluno
    if (req.user.role === 'professor') {
      params.push(req.user.id);
      query += ` AND ts.teacher_id = $${params.length}`;
    } else if (req.user.role === 'responsavel') {
      params.push(req.user.student_id);
      query += ` AND ts.student_id = $${params.length}`;
    } else if (teacher_id) {
      params.push(parseInt(teacher_id));
      query += ` AND ts.teacher_id = $${params.length}`;
    }

    if (student_id) {
      params.push(parseInt(student_id));
      query += ` AND ts.student_id = $${params.length}`;
    }

    if (classroom_id) {
      params.push(parseInt(classroom_id));
      query += ` AND (ts.classroom_id = $${params.length} OR (ts.classroom_id IS NULL AND sub.classroom_id = $${params.length}))`;
    }

    if (frequency_type) {
      params.push(frequency_type);
      query += ` AND (ts.frequency_type = $${params.length} OR st.frequency_type = $${params.length})`;
    }

    if (day_of_week !== undefined && day_of_week !== '') {
      params.push(parseInt(day_of_week));
      query += ` AND ts.day_of_week = $${params.length}`;
    }

    query += ` ORDER BY ts.day_of_week ASC, ts.start_time ASC, ts.id ASC`;
    const result = await pool.query(query, params);

    const dayNames = {
      0: 'Domingo',
      1: 'Segunda-feira',
      2: 'Terça-feira',
      3: 'Quarta-feira',
      4: 'Quinta-feira',
      5: 'Sexta-feira',
      6: 'Sábado'
    };

    const enriched = result.rows.map(row => ({
      ...row,
      day_name: dayNames[row.day_of_week] || 'Dia não definido',
      formatted_time_range: `${row.start_time} - ${row.end_time}`
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastrar Horário (Exclusivo Administrador)
app.post('/api/schedules', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      teacher_id, student_id, subject_id, classroom_id, day_of_week, start_time, end_time,
      room_or_info, notes, frequency_type, recurrence_interval_days, start_date, end_date
    } = req.body;

    if (!teacher_id || day_of_week === undefined || day_of_week === null || day_of_week === '' || !start_time || !end_time) {
      return res.status(400).json({ error: 'Professor, Dia da semana, Horário Inicial e Horário Final são obrigatórios.' });
    }

    const freq = frequency_type || 'semanal';
    if (!VALID_FREQUENCIES.includes(freq)) {
      return res.status(400).json({ error: 'Frequência inválida. Use semanal, quinzenal ou custom_dias.' });
    }
    if (start_date && end_date && toISODate(end_date) < toISODate(start_date)) {
      return res.status(400).json({ error: 'A data final do horário não pode ser anterior à data inicial.' });
    }

    const tId = parseInt(teacher_id);
    const sId = student_id ? parseInt(student_id) : null;
    const subId = subject_id ? parseInt(subject_id) : null;
    const sTime = start_time.trim();
    const eTime = end_time.trim();

    const check = await validateScheduleSlot(client, {
      teacherId: tId, studentId: sId, subjectId: subId,
      classroomId: classroom_id ? parseInt(classroom_id) : null,
      dayOfWeek: parseInt(day_of_week), startTime: sTime, endTime: eTime
    });
    if (check.error) return res.status(400).json({ error: check.error });

    let classroomName = null;
    if (check.classroomId) {
      const roomRes = await client.query('SELECT name FROM classrooms WHERE id = $1', [check.classroomId]);
      classroomName = roomRes.rows[0] ? roomRes.rows[0].name : null;
    }
    const intervalDays = recurrence_interval_days ? parseInt(recurrence_interval_days) : (freq === 'quinzenal' ? 14 : 7);
    const resolvedRoomInfo = room_or_info ? room_or_info.trim() : (classroomName || 'Sala Presencial / Online');

    await client.query('BEGIN');
    const result = await client.query(`
      INSERT INTO teacher_schedules
        (teacher_id, student_id, subject_id, classroom_id, day_of_week, start_time, end_time, room_or_info, notes, frequency_type, recurrence_interval_days, start_date, end_date, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::date, CURRENT_DATE), $13, 'ativo')
      RETURNING *
    `, [
      tId, sId, subId, check.classroomId, parseInt(day_of_week), sTime, eTime,
      resolvedRoomInfo, notes ? notes.trim() : null, freq, intervalDays,
      toISODate(start_date), toISODate(end_date)
    ]);

    if (sId) {
      if (subId) {
        await client.query('INSERT INTO student_subjects (student_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sId, subId]);
      }
      await syncStudentTeacher(client, sId);
    }
    await client.query('COMMIT');

    res.status(201).json({
      message: 'Horário cadastrado com sucesso!',
      schedule: result.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Atualizar Horário (Exclusivo Administrador)
app.put('/api/schedules/:id', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id);
    const body = req.body;
    const has = key => Object.prototype.hasOwnProperty.call(body, key);

    const currentRes = await client.query('SELECT * FROM teacher_schedules WHERE id = $1', [id]);
    const current = currentRes.rows[0];
    if (!current) return res.status(404).json({ error: 'Horário não encontrado.' });

    const nullable = v => (v === 'null' || v === null || v === '' ? null : parseInt(v));
    const next = {
      teacher_id: body.teacher_id ? parseInt(body.teacher_id) : current.teacher_id,
      student_id: has('student_id') ? nullable(body.student_id) : current.student_id,
      subject_id: has('subject_id') ? nullable(body.subject_id) : current.subject_id,
      classroom_id: has('classroom_id') ? nullable(body.classroom_id) : current.classroom_id,
      day_of_week: has('day_of_week') && body.day_of_week !== '' ? parseInt(body.day_of_week) : current.day_of_week,
      start_time: body.start_time ? body.start_time.trim() : current.start_time,
      end_time: body.end_time ? body.end_time.trim() : current.end_time,
      status: body.status || current.status,
      frequency_type: body.frequency_type || current.frequency_type,
      recurrence_interval_days: body.recurrence_interval_days ? parseInt(body.recurrence_interval_days) : current.recurrence_interval_days,
      start_date: has('start_date') ? toISODate(body.start_date) : toISODate(current.start_date),
      end_date: has('end_date') ? toISODate(body.end_date) : toISODate(current.end_date),
      room_or_info: has('room_or_info') ? body.room_or_info : current.room_or_info,
      notes: has('notes') ? body.notes : current.notes
    };

    if (!['ativo', 'inativo'].includes(next.status)) return res.status(400).json({ error: 'Status do horário inválido.' });
    if (!VALID_FREQUENCIES.includes(next.frequency_type)) {
      return res.status(400).json({ error: 'Frequência inválida. Use semanal, quinzenal ou custom_dias.' });
    }
    if (next.start_date && next.end_date && next.end_date < next.start_date) {
      return res.status(400).json({ error: 'A data final do horário não pode ser anterior à data inicial.' });
    }

    let classroomId = next.classroom_id;
    if (next.status === 'ativo') {
      const check = await validateScheduleSlot(client, {
        scheduleId: id, teacherId: next.teacher_id, studentId: next.student_id, subjectId: next.subject_id,
        classroomId: next.classroom_id, dayOfWeek: next.day_of_week, startTime: next.start_time, endTime: next.end_time
      });
      if (check.error) return res.status(400).json({ error: check.error });
      classroomId = check.classroomId;
    }

    await client.query('BEGIN');
    const result = await client.query(`
      UPDATE teacher_schedules
      SET teacher_id = $1, student_id = $2, subject_id = $3, classroom_id = $4,
          day_of_week = $5, start_time = $6, end_time = $7, room_or_info = $8, notes = $9,
          status = $10, frequency_type = $11, recurrence_interval_days = $12,
          start_date = $13, end_date = $14, updated_at = CURRENT_TIMESTAMP
      WHERE id = $15
      RETURNING *
    `, [
      next.teacher_id, next.student_id, next.subject_id, classroomId,
      next.day_of_week, next.start_time, next.end_time, next.room_or_info, next.notes,
      next.status, next.frequency_type, next.recurrence_interval_days,
      next.start_date, next.end_date, id
    ]);

    if (next.student_id && next.subject_id && next.status === 'ativo') {
      await client.query('INSERT INTO student_subjects (student_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [next.student_id, next.subject_id]);
    }
    // Recalcula o responsável do aluno atual e do anterior (se o horário mudou de aluno)
    const touched = new Set([current.student_id, next.student_id].filter(Boolean));
    for (const sid of touched) await syncStudentTeacher(client, sid);
    await client.query('COMMIT');

    res.json({
      message: 'Horário atualizado com sucesso!',
      schedule: result.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Excluir Horário (Exclusivo Administrador)
app.delete('/api/schedules/:id', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');
    const result = await client.query('DELETE FROM teacher_schedules WHERE id = $1 RETURNING id, student_id', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Horário não encontrado.' });
    }
    if (result.rows[0].student_id) await syncStudentTeacher(client, result.rows[0].student_id);
    await client.query('COMMIT');
    res.json({ message: 'Horário removido com sucesso!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// ROTAS DO PORTAL DOS PAIS & AGENDA DO ALUNO
// ==========================================

// Dados do Aluno e Horários para os Pais
app.get('/api/parent/student', authenticateToken, async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.query.student_id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const studentId = scope.studentId;

    const studentRes = await pool.query(`${STUDENT_SELECT} WHERE st.id = $1`, [studentId]);

    if (studentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Aluno não encontrado.' });
    }

    const student = studentRes.rows[0];

    // Horários semanais das matérias do aluno
    const schedulesRes = await pool.query(`
      SELECT 
        ts.id,
        ts.day_of_week,
        ts.start_time,
        ts.end_time,
        ts.room_or_info,
        ts.notes,
        ts.frequency_type,
        ts.recurrence_interval_days,
        ts.start_date,
        sub.id as subject_id,
        sub.name as subject_name,
        u.name as teacher_name
      FROM teacher_schedules ts
      LEFT JOIN subjects sub ON sub.id = ts.subject_id
      LEFT JOIN users u ON u.id = ts.teacher_id
      WHERE (ts.student_id = $1 OR (ts.student_id IS NULL AND sub.id IN (SELECT subject_id FROM student_subjects WHERE student_id = $1)))
        AND ts.status = 'ativo'
      ORDER BY ts.day_of_week ASC, ts.start_time ASC
    `, [studentId]);

    res.json({
      student,
      schedules: schedulesRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar Agenda de Recados para os Pais
app.get('/api/parent/agenda', authenticateToken, async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.query.student_id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const studentId = scope.studentId;

    const result = await pool.query(`
      SELECT 
        sa.*,
        to_char(sa.entry_date, 'DD/MM/YYYY') as entry_date_br,
        to_char(sa.entry_date, 'DD/MM/YYYY') || ' - ' || 
        CASE 
          WHEN sa.entry_time IS NOT NULL AND sa.entry_time != ''
          THEN replace(substring(sa.entry_time from 1 for 5), ':', 'h') || 'm'
          ELSE '08h00m'
        END as formatted_date_time,
        to_char(sa.read_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24"h"MI"m"') as read_at_formatted,
        to_char(sa.parent_response_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24"h"MI"m"') as parent_response_at_formatted
      FROM student_agenda sa
      WHERE sa.student_id = $1
      ORDER BY sa.entry_date DESC, sa.id DESC
    `, [studentId]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pais confirmam leitura de um recado
app.post('/api/parent/agenda/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!['responsavel', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Apenas a família (ou a coordenação) pode confirmar leitura e responder recados.' });
    }
    const studentId = req.user.role === 'responsavel' ? req.user.student_id : (req.body.student_id || null);

    const result = await pool.query(`
      UPDATE student_agenda 
      SET read_by_parent = true,
          read_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND ($2::int IS NULL OR student_id = $2)
      RETURNING *
    `, [id, studentId || null]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Recado não encontrado.' });
    }

    res.json({ message: 'Leitura confirmada pela família!', entry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pais respondem ao recado/escola
app.post('/api/parent/agenda/:id/respond', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { response } = req.body;
    if (!['responsavel', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Apenas a família (ou a coordenação) pode confirmar leitura e responder recados.' });
    }
    const studentId = req.user.role === 'responsavel' ? req.user.student_id : (req.body.student_id || null);

    if (!response || !response.trim()) {
      return res.status(400).json({ error: 'A mensagem de resposta não pode estar vazia.' });
    }

    const result = await pool.query(`
      UPDATE student_agenda 
      SET parent_response = $1,
          parent_response_at = CURRENT_TIMESTAMP,
          read_by_parent = true,
          read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE id = $2 AND ($3::int IS NULL OR student_id = $3)
      RETURNING *
    `, [response.trim(), id, studentId || null]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Recado não encontrado.' });
    }

    res.json({ message: 'Resposta enviada com sucesso à coordenação!', entry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico de aulas no portal dos pais
app.get('/api/parent/classes', authenticateToken, async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.query.student_id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const studentId = scope.studentId;

    const logsRes = await pool.query(`
      SELECT 
        cl.*,
        COALESCE(sub.name, 'Reforço / Geral') as subject_name,
        COALESCE(u.name, cl.teacher_name, 'Professor') as teacher_display_name,
        to_char(cl.class_date, 'DD/MM/YYYY') as class_date_br,
        to_char(cl.class_date, 'DD/MM/YYYY') || ' - ' || 
        COALESCE(
          CASE 
            WHEN cl.class_time IS NOT NULL AND cl.class_time != ''
            THEN replace(substring(cl.class_time from 1 for 5), ':', 'h') || 'm'
            ELSE to_char(cl.created_at AT TIME ZONE 'America/Sao_Paulo', 'HH24"h"MI"m"')
          END,
          '07h30m'
        ) as formatted_date_time
      FROM class_logs cl
      LEFT JOIN subjects sub ON sub.id = cl.subject_id
      LEFT JOIN users u ON u.id = cl.teacher_id
      WHERE cl.student_id = $1
      ORDER BY cl.class_date DESC, cl.id DESC
    `, [studentId]);

    res.json(logsRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROTAS DE GESTÃO DA AGENDA (PROFESSORES & ADMIN)
// ==========================================

// Obter agenda de um aluno específico
app.get('/api/students/:id/agenda', authenticateToken, async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.params.id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const id = scope.studentId;
    const result = await pool.query(`
      SELECT 
        sa.*,
        to_char(sa.entry_date, 'DD/MM/YYYY') as entry_date_br,
        to_char(sa.entry_date, 'DD/MM/YYYY') || ' - ' || 
        CASE 
          WHEN sa.entry_time IS NOT NULL AND sa.entry_time != ''
          THEN replace(substring(sa.entry_time from 1 for 5), ':', 'h') || 'm'
          ELSE '08h00m'
        END as formatted_date_time,
        to_char(sa.read_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24"h"MI"m"') as read_at_formatted,
        to_char(sa.parent_response_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24"h"MI"m"') as parent_response_at_formatted
      FROM student_agenda sa
      WHERE sa.student_id = $1
      ORDER BY sa.entry_date DESC, sa.id DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Adicionar novo recado/aviso na agenda do aluno
app.post('/api/students/:id/agenda', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, 
      content, 
      category = 'recado', 
      entry_date, 
      entry_time, 
      is_important = false 
    } = req.body;

    if (!title || !title.trim() || !content || !content.trim()) {
      return res.status(400).json({ error: 'Título e conteúdo do recado são obrigatórios.' });
    }
    const scope = await resolveStudentScope(req, id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    if (entry_time && !TIME_RE.test(entry_time)) {
      return res.status(400).json({ error: 'Horário do recado deve estar no formato HH:MM.' });
    }

    const spNow = getSaoPauloNow();
    const finalDate = entry_date || spNow.dateStr;
    const finalTime = entry_time || spNow.timeStr;
    const authorName = req.user ? req.user.name : 'Equipe Pedagógica';
    const authorId = req.user ? req.user.id : null;

    const result = await pool.query(`
      INSERT INTO student_agenda 
        (student_id, author_id, author_name, entry_date, entry_time, category, title, content, is_important)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *,
        to_char(entry_date, 'DD/MM/YYYY') as entry_date_br,
        to_char(entry_date, 'DD/MM/YYYY') || ' - ' || 
        CASE 
          WHEN entry_time IS NOT NULL AND entry_time != ''
          THEN replace(substring(entry_time from 1 for 5), ':', 'h') || 'm'
          ELSE '08h00m'
        END as formatted_date_time
    `, [
      id, 
      authorId, 
      authorName, 
      finalDate, 
      finalTime, 
      category, 
      title.trim(), 
      content.trim(), 
      Boolean(is_important)
    ]);

    res.status(201).json({
      message: 'Recado adicionado na agenda com sucesso!',
      entry: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar recado da agenda
app.put('/api/agenda/:id', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, category, entry_date, entry_time, is_important } = req.body;
    const ownerRes = await pool.query('SELECT author_id FROM student_agenda WHERE id = $1', [id]);
    if (ownerRes.rows.length === 0) return res.status(404).json({ error: 'Recado não encontrado.' });
    if (req.user.role === 'professor' && ownerRes.rows[0].author_id !== req.user.id) {
      return res.status(403).json({ error: 'Acesso negado: você só pode alterar recados escritos por você.' });
    }

    const result = await pool.query(`
      UPDATE student_agenda
      SET title = COALESCE($1, title),
          content = COALESCE($2, content),
          category = COALESCE($3, category),
          entry_date = COALESCE($4, entry_date),
          entry_time = COALESCE($5, entry_time),
          is_important = COALESCE($6, is_important),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *,
        to_char(entry_date, 'DD/MM/YYYY') as entry_date_br,
        to_char(entry_date, 'DD/MM/YYYY') || ' - ' || 
        CASE 
          WHEN entry_time IS NOT NULL AND entry_time != ''
          THEN replace(substring(entry_time from 1 for 5), ':', 'h') || 'm'
          ELSE '08h00m'
        END as formatted_date_time
    `, [
      title ? title.trim() : null,
      content ? content.trim() : null,
      category,
      entry_date || null,
      entry_time || null,
      is_important !== undefined ? Boolean(is_important) : null,
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Recado não encontrado.' });
    }

    res.json({ message: 'Recado atualizado com sucesso!', entry: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excluir recado da agenda
app.delete('/api/agenda/:id', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const { id } = req.params;
    const ownerRes = await pool.query('SELECT author_id FROM student_agenda WHERE id = $1', [id]);
    if (ownerRes.rows.length === 0) return res.status(404).json({ error: 'Recado não encontrado.' });
    if (req.user.role === 'professor' && ownerRes.rows[0].author_id !== req.user.id) {
      return res.status(403).json({ error: 'Acesso negado: você só pode alterar recados escritos por você.' });
    }
    const result = await pool.query('DELETE FROM student_agenda WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Recado não encontrado.' });
    }
    res.json({ message: 'Recado removido com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// 🌟 MÓDULO: LEADS & CAPTAÇÃO DO SITE INSTITUCIONAL
// ========================================================

// Envio de formulário de contato / pré-matrícula pelo site (público)
app.post('/api/leads', async (req, res) => {
  try {
    const { name, phone, email, course_interest, student_grade, message } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Nome e telefone para contato são obrigatórios.' });
    }

    const result = await pool.query(`
      INSERT INTO leads_contacts (name, phone, email, course_interest, student_grade, message, status, in_kanban, source)
      VALUES ($1, $2, $3, $4, $5, $6, 'novo', false, 'site')
      RETURNING *
    `, [
      name.trim(),
      phone.trim(),
      email ? email.trim() : null,
      course_interest || 'Interesse Geral',
      student_grade || null,
      message ? message.trim() : null
    ]);

    res.status(201).json({
      message: 'Solicitação de atendimento enviada com sucesso! A equipe pedagógica entrará em contato em breve.',
      lead: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar contato: ' + err.message });
  }
});

// Listagem de leads para a coordenação (Admin)
app.get('/api/leads', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM leads_contacts 
      ORDER BY 
        CASE status WHEN 'novo' THEN 1 WHEN 'contatado' THEN 2 WHEN 'agendado' THEN 3 ELSE 4 END,
        COALESCE(updated_at, created_at) DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastro manual de lead pela coordenação (Admin)
const LEAD_STATUSES = ['novo', 'contatado', 'agendado', 'matriculado', 'arquivado'];
const LEAD_SOURCES = ['site', 'whatsapp', 'instagram', 'facebook', 'indicacao', 'telefone', 'presencial', 'outro'];

app.post('/api/leads/manual', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, phone, email, course_interest, student_grade, message, notes, status = 'novo', source = 'outro', in_kanban = true } = req.body;
    if (!name || !name.trim() || !phone || !phone.trim()) {
      return res.status(400).json({ error: 'Nome e telefone são obrigatórios.' });
    }
    if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ error: 'Etapa inválida.' });
    if (!LEAD_SOURCES.includes(source)) return res.status(400).json({ error: 'Origem inválida.' });
    const result = await pool.query(`
      INSERT INTO leads_contacts (name, phone, email, course_interest, student_grade, message, notes, status, source, in_kanban)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [name.trim(), phone.trim(), (email || '').trim() || null, (course_interest || '').trim() || null,
        (student_grade || '').trim() || null, (message || '').trim() || null, (notes || '').trim() || null, status, source, Boolean(in_kanban)]);
    res.status(201).json({ message: 'Lead cadastrado!', lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar etapa e dados do lead (Admin)
app.patch('/api/leads/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const body = req.body;
    if (body.status && !LEAD_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: 'Status do contato inválido.' });
    }
    if (body.source && !LEAD_SOURCES.includes(body.source)) {
      return res.status(400).json({ error: 'Origem inválida.' });
    }
    if (body.name !== undefined && !String(body.name).trim()) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
    if (body.phone !== undefined && !String(body.phone).trim()) return res.status(400).json({ error: 'O telefone não pode ficar vazio.' });

    const editable = ['name', 'phone', 'email', 'course_interest', 'student_grade', 'message', 'notes', 'status', 'source'];
    const sets = [];
    const params = [];
    for (const f of editable) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        params.push(body[f] === null ? null : (String(body[f]).trim() || null));
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'in_kanban')) {
      params.push(Boolean(body.in_kanban));
      sets.push(`in_kanban = $${params.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    const result = await pool.query(`UPDATE leads_contacts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Contato não encontrado.' });
    res.json({ message: 'Lead atualizado!', lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excluir lead (Admin)
app.delete('/api/leads/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM leads_contacts WHERE id = $1', [id]);
    res.json({ message: 'Contato removido com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// 📚 MÓDULO: CURSOS, MÓDULOS & AULAS ONLINE (LMS & EAD)
// ========================================================

// Listagem de cursos (Público & Logado). Admin com ?all=1 vê também os inativos.
app.get('/api/courses', optionalAuth, async (req, res) => {
  try {
    const showAll = req.query.all === '1' && req.user && req.user.role === 'admin';
    const result = await pool.query(`
      SELECT
        c.*,
        s.name as subject_name,
        s.code as subject_code,
        COUNT(DISTINCT cm.id) as total_modules,
        COUNT(DISTINCT cl.id) as total_lessons,
        COALESCE(SUM(cl.duration_minutes), 0) as total_minutes
      FROM courses c
      LEFT JOIN subjects s ON s.id = c.subject_id
      LEFT JOIN course_modules cm ON cm.course_id = c.id
      LEFT JOIN course_lessons cl ON cl.module_id = cm.id
      WHERE ($1::boolean OR c.status = 'ativo')
      GROUP BY c.id, s.name, s.code
      ORDER BY c.featured DESC, c.title ASC
    `, [showAll]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detalhes completos do curso com módulos e aulas (Público & Logado)
app.get('/api/courses/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const courseRes = await pool.query(`
      SELECT c.*, s.name as subject_name, s.code as subject_code
      FROM courses c
      LEFT JOIN subjects s ON s.id = c.subject_id
      WHERE c.id = $1
    `, [id]);

    if (courseRes.rows.length === 0) return res.status(404).json({ error: 'Curso não encontrado.' });
    const course = courseRes.rows[0];
    if (course.status !== 'ativo' && !(req.user && req.user.role === 'admin')) {
      return res.status(404).json({ error: 'Curso não encontrado.' });
    }

    const studentId = req.user && req.user.student_id ? req.user.student_id : null;

    const modulesRes = await pool.query(`
      SELECT
        cm.id, cm.title, cm.description, cm.order_index,
        COALESCE(
          json_agg(
            json_build_object(
              'id', cl.id,
              'title', cl.title,
              'description', cl.description,
              'video_url', cl.video_url,
              'live_meeting_url', cl.live_meeting_url,
              'duration_minutes', cl.duration_minutes,
              'order_index', cl.order_index,
              'resources', cl.resources,
              'completed', COALESCE(slp.completed, false)
            ) ORDER BY cl.order_index ASC, cl.id ASC
          ) FILTER (WHERE cl.id IS NOT NULL), '[]'
        ) as lessons
      FROM course_modules cm
      LEFT JOIN course_lessons cl ON cl.module_id = cm.id
      LEFT JOIN student_lesson_progress slp ON slp.lesson_id = cl.id AND slp.student_id = $2
      WHERE cm.course_id = $1
      GROUP BY cm.id
      ORDER BY cm.order_index ASC, cm.id ASC
    `, [id, studentId]);

    course.modules = modulesRes.rows;

    if (studentId) {
      let totalLessons = 0;
      let completedLessons = 0;
      course.modules.forEach(m => {
        (m.lessons || []).forEach(l => {
          totalLessons++;
          if (l.completed) completedLessons++;
        });
      });
      course.progress = {
        total: totalLessons,
        completed: completedLessons,
        percentage: totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0
      };
    }

    res.json(course);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function validateCoursePayload(body, isCreate) {
  if (isCreate && (!body.title || !String(body.title).trim())) return 'Título do curso é obrigatório.';
  if (body.price !== undefined && body.price !== null && body.price !== '' && !(parseFloat(body.price) >= 0)) return 'O valor do curso não pode ser negativo.';
  if (body.workload_hours !== undefined && body.workload_hours !== null && body.workload_hours !== '' && !(parseInt(body.workload_hours) >= 1)) return 'A carga horária deve ser maior que zero.';
  if (body.status && !['ativo', 'inativo'].includes(body.status)) return 'Status do curso inválido.';
  return null;
}

// Cadastrar novo curso (Admin)
app.post('/api/courses', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { code, subject_id, title, headline, description, category, modality, price, workload_hours, icon, badge, featured } = req.body;
    const err = validateCoursePayload(req.body, true);
    if (err) return res.status(400).json({ error: err });

    const finalCode = code && String(code).trim() ? String(code).trim() : 'curso_' + Date.now();
    const dup = await pool.query('SELECT id FROM courses WHERE code = $1 OR LOWER(title) = LOWER($2)', [finalCode, title.trim()]);
    if (dup.rows.length > 0) return res.status(400).json({ error: 'Já existe um curso com este título ou código.' });

    const result = await pool.query(`
      INSERT INTO courses
        (code, subject_id, title, headline, description, category, modality, price, workload_hours, icon, badge, featured, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ativo')
      RETURNING *
    `, [
      finalCode,
      subject_id || null,
      title.trim(),
      headline || null,
      description || null,
      category || 'reforco',
      modality || 'hibrido',
      price !== undefined && price !== '' ? parseFloat(price) : 350.00,
      workload_hours ? parseInt(workload_hours) : 40,
      icon || '📚',
      badge || null,
      featured !== undefined ? Boolean(featured) : true
    ]);

    res.status(201).json({ message: 'Curso criado com sucesso!', course: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar curso (Admin)
app.put('/api/courses/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const err = validateCoursePayload(req.body, false);
    if (err) return res.status(400).json({ error: err });
    const { title, headline, description, category, modality, price, workload_hours, icon, badge, featured, status, subject_id } = req.body;
    if (title) {
      const dup = await pool.query('SELECT id FROM courses WHERE LOWER(title) = LOWER($1) AND id <> $2', [title.trim(), id]);
      if (dup.rows.length > 0) return res.status(400).json({ error: 'Já existe outro curso com este título.' });
    }
    const hasSubject = Object.prototype.hasOwnProperty.call(req.body, 'subject_id');
    const result = await pool.query(`
      UPDATE courses
      SET title = COALESCE($1, title),
          headline = COALESCE($2, headline),
          description = COALESCE($3, description),
          category = COALESCE($4, category),
          modality = COALESCE($5, modality),
          price = COALESCE($6, price),
          workload_hours = COALESCE($7, workload_hours),
          icon = COALESCE($8, icon),
          badge = COALESCE($9, badge),
          featured = COALESCE($10, featured),
          status = COALESCE($11, status),
          subject_id = CASE WHEN $13::boolean THEN $14::int ELSE subject_id END
      WHERE id = $12
      RETURNING *
    `, [
      title ? title.trim() : null, headline ?? null, description ?? null, category || null, modality || null,
      price !== undefined && price !== '' ? parseFloat(price) : null,
      workload_hours ? parseInt(workload_hours) : null,
      icon || null, badge ?? null, featured !== undefined ? Boolean(featured) : null, status || null, id,
      hasSubject, subject_id ? parseInt(subject_id) : null
    ]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Curso não encontrado.' });
    res.json({ message: 'Curso atualizado com sucesso!', course: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastrar módulo em um curso (Admin)
app.post('/api/courses/:courseId/modules', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { courseId } = req.params;
    const { title, description, order_index } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Título do módulo é obrigatório.' });
    const course = await pool.query('SELECT id FROM courses WHERE id = $1', [courseId]);
    if (course.rows.length === 0) return res.status(404).json({ error: 'Curso não encontrado.' });

    const result = await pool.query(`
      INSERT INTO course_modules (course_id, title, description, order_index)
      VALUES ($1, $2, $3, COALESCE($4, (SELECT COALESCE(MAX(order_index), 0) + 1 FROM course_modules WHERE course_id = $1)))
      RETURNING *
    `, [courseId, title.trim(), description || null, order_index ? parseInt(order_index) : null]);

    res.status(201).json({ message: 'Módulo adicionado com sucesso!', module: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar / excluir módulo (Admin)
app.put('/api/modules/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, description, order_index } = req.body;
    if (title !== undefined && !String(title).trim()) return res.status(400).json({ error: 'Título do módulo é obrigatório.' });
    const result = await pool.query(`
      UPDATE course_modules
      SET title = COALESCE($1, title), description = COALESCE($2, description), order_index = COALESCE($3, order_index)
      WHERE id = $4 RETURNING *
    `, [title ? title.trim() : null, description ?? null, order_index ? parseInt(order_index) : null, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Módulo não encontrado.' });
    res.json({ message: 'Módulo atualizado com sucesso!', module: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/modules/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM course_modules WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Módulo não encontrado.' });
    res.json({ message: 'Módulo e suas aulas foram removidos.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function validateLessonPayload(body, isCreate) {
  if (isCreate && (!body.title || !String(body.title).trim())) return 'Título da aula é obrigatório.';
  for (const field of ['video_url', 'live_meeting_url']) {
    if (body[field] && !/^https?:\/\//i.test(String(body[field]).trim())) return 'Os links de vídeo e de sala ao vivo devem começar com http:// ou https://';
  }
  if (body.duration_minutes !== undefined && body.duration_minutes !== null && body.duration_minutes !== '' &&
      !(parseInt(body.duration_minutes) >= 1)) return 'A duração da aula deve ser maior que zero.';
  return null;
}

// Cadastrar aula em um módulo (Admin & Professor)
app.post('/api/modules/:moduleId/lessons', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const { moduleId } = req.params;
    const { title, description, video_url, live_meeting_url, duration_minutes, order_index, resources } = req.body;
    const err = validateLessonPayload(req.body, true);
    if (err) return res.status(400).json({ error: err });
    const mod = await pool.query('SELECT id FROM course_modules WHERE id = $1', [moduleId]);
    if (mod.rows.length === 0) return res.status(404).json({ error: 'Módulo não encontrado.' });

    const result = await pool.query(`
      INSERT INTO course_lessons
        (module_id, title, description, video_url, live_meeting_url, duration_minutes, order_index, resources)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6, 45),
              COALESCE($7, (SELECT COALESCE(MAX(order_index), 0) + 1 FROM course_lessons WHERE module_id = $1)), $8::jsonb)
      RETURNING *
    `, [
      moduleId,
      title.trim(),
      description || null,
      video_url ? video_url.trim() : null,
      live_meeting_url ? live_meeting_url.trim() : null,
      duration_minutes ? parseInt(duration_minutes) : null,
      order_index ? parseInt(order_index) : null,
      JSON.stringify(resources || [])
    ]);

    res.status(201).json({ message: 'Aula adicionada com sucesso!', lesson: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar / excluir aula (Admin & Professor)
app.put('/api/lessons/:id', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const err = validateLessonPayload(req.body, false);
    if (err) return res.status(400).json({ error: err });
    const { title, description, video_url, live_meeting_url, duration_minutes, order_index } = req.body;
    const has = key => Object.prototype.hasOwnProperty.call(req.body, key);
    const result = await pool.query(`
      UPDATE course_lessons
      SET title = COALESCE($1, title),
          description = COALESCE($2, description),
          video_url = CASE WHEN $3::boolean THEN $4 ELSE video_url END,
          live_meeting_url = CASE WHEN $5::boolean THEN $6 ELSE live_meeting_url END,
          duration_minutes = COALESCE($7, duration_minutes),
          order_index = COALESCE($8, order_index)
      WHERE id = $9 RETURNING *
    `, [
      title ? title.trim() : null, description ?? null,
      has('video_url'), video_url ? video_url.trim() : null,
      has('live_meeting_url'), live_meeting_url ? live_meeting_url.trim() : null,
      duration_minutes ? parseInt(duration_minutes) : null, order_index ? parseInt(order_index) : null,
      req.params.id
    ]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Aula não encontrada.' });
    res.json({ message: 'Aula atualizada com sucesso!', lesson: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lessons/:id', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM course_lessons WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Aula não encontrada.' });
    res.json({ message: 'Aula removida com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marcar/desmarcar aula como concluída (Portal da Família / Aluno; admin pode informar student_id)
app.post('/api/lessons/:id/progress', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { completed } = req.body;
    if (!['responsavel', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Apenas o aluno/família pode marcar o progresso das aulas.' });
    }
    const studentId = req.user.role === 'responsavel' ? req.user.student_id : req.body.student_id;
    if (!studentId) return res.status(400).json({ error: 'Identificação do aluno não encontrada.' });

    const lesson = await pool.query('SELECT id FROM course_lessons WHERE id = $1', [id]);
    if (lesson.rows.length === 0) return res.status(404).json({ error: 'Aula não encontrada.' });

    const isCompleted = completed !== undefined ? Boolean(completed) : true;

    await pool.query(`
      INSERT INTO student_lesson_progress (student_id, lesson_id, completed, completed_at)
      VALUES ($1, $2, $3, CASE WHEN $3 = true THEN CURRENT_TIMESTAMP ELSE NULL END)
      ON CONFLICT (student_id, lesson_id)
      DO UPDATE SET completed = $3, completed_at = CASE WHEN $3 = true THEN CURRENT_TIMESTAMP ELSE NULL END
    `, [studentId, id, isCompleted]);

    res.json({ message: 'Progresso salvo com sucesso!', lesson_id: id, completed: isCompleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Próximas aulas ao vivo para o aluno logado (Google Meet / Sala Virtual)
app.get('/api/student/live-classes', authenticateToken, async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.query.student_id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const studentId = scope.studentId;

    // Grade do aluno (aulas individuais e turmas gerais das matérias dele), com dados de recorrência
    // para o front calcular a próxima aula. O link da sala virtual só vem se estiver cadastrado.
    const schedulesRes = await pool.query(`
      SELECT 
        ts.id,
        ts.day_of_week,
        ts.start_time,
        ts.end_time,
        ts.frequency_type,
        ts.recurrence_interval_days,
        ts.start_date,
        ts.end_date,
        ts.created_at,
        COALESCE(ts.live_meeting_url, c.live_meeting_url) as live_meeting_url,
        s.name as subject_name,
        u.name as teacher_name,
        c.name as classroom_name,
        c.type as classroom_type
      FROM teacher_schedules ts
      LEFT JOIN subjects s ON s.id = ts.subject_id
      JOIN users u ON u.id = ts.teacher_id
      LEFT JOIN classrooms c ON c.id = COALESCE(ts.classroom_id, s.classroom_id)
      WHERE (ts.student_id = $1 OR (ts.student_id IS NULL AND ts.subject_id IN (SELECT subject_id FROM student_subjects WHERE student_id = $1)))
        AND ts.status = 'ativo'
      ORDER BY ts.day_of_week ASC, ts.start_time ASC
    `, [studentId]);

    // Busca aulas online com agendamento direto de cursos
    const lessonsRes = await pool.query(`
      SELECT 
        cl.id,
        cl.title,
        cl.duration_minutes,
        cl.live_meeting_url,
        c.title as course_title,
        cm.title as module_title
      FROM course_lessons cl
      JOIN course_modules cm ON cm.id = cl.module_id
      JOIN courses c ON c.id = cm.course_id
      WHERE cl.live_meeting_url IS NOT NULL
      LIMIT 5
    `);

    res.json({
      student_id: studentId,
      schedules: schedulesRes.rows,
      live_lessons: lessonsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// 📝 MÓDULO: TAREFAS, REDAÇÕES & FEEDBACK PEDAGÓGICO
// ========================================================

// Listagem de tarefas e redações (família: do próprio aluno; professor: as suas e as sem professor dos seus alunos)
app.get('/api/assignments', authenticateToken, async (req, res) => {
  try {
    let query = `
      SELECT
        sa.*,
        st.name as student_name,
        u.name as teacher_name,
        c.title as course_title,
        TO_CHAR(sa.due_date, 'DD/MM/YYYY') as formatted_due_date,
        TO_CHAR(sa.submitted_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24:MI') as formatted_submitted_at,
        TO_CHAR(sa.graded_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24:MI') as formatted_graded_at
      FROM student_assignments sa
      JOIN students st ON st.id = sa.student_id
      LEFT JOIN users u ON u.id = sa.teacher_id
      LEFT JOIN courses c ON c.id = sa.course_id
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role === 'responsavel') {
      params.push(req.user.student_id);
      query += ` AND sa.student_id = $${params.length}`;
    } else if (req.user.role === 'professor') {
      params.push(req.user.id);
      query += ` AND (sa.teacher_id = $${params.length} OR (sa.teacher_id IS NULL AND ${teacherStudentsSQL('st', '$' + params.length)}))`;
    }
    if (req.query.status) {
      params.push(req.query.status);
      query += ` AND sa.status = $${params.length}`;
    }

    query += ` ORDER BY
      CASE sa.status WHEN 'enviado' THEN 1 WHEN 'pendente' THEN 2 ELSE 3 END,
      sa.due_date ASC NULLS LAST, sa.id DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cadastrar nova tarefa / proposta de redação (Admin ou Professor)
app.post('/api/assignments', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const { student_id, course_id, lesson_id, title, instructions, due_date } = req.body;
    if (!student_id || !title || !String(title).trim()) {
      return res.status(400).json({ error: 'Aluno e título da atividade são obrigatórios.' });
    }
    const scope = await resolveStudentScope(req, student_id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const st = await pool.query("SELECT id FROM students WHERE id = $1 AND status = 'ativo'", [student_id]);
    if (st.rows.length === 0) return res.status(400).json({ error: 'Aluno não encontrado ou inativo.' });
    if (due_date && !toISODate(due_date)) return res.status(400).json({ error: 'Data de entrega inválida.' });
    if (due_date && toISODate(due_date) < getSaoPauloNow().dateStr) {
      return res.status(400).json({ error: 'A data de entrega não pode estar no passado.' });
    }

    let teacherId = null;
    if (req.user.role === 'professor') teacherId = req.user.id;
    else if (req.body.teacher_id) {
      const t = await getActiveProfessor(pool, parseInt(req.body.teacher_id));
      if (!t) return res.status(400).json({ error: 'O professor selecionado não existe ou está inativo.' });
      teacherId = t.id;
    }

    const result = await pool.query(`
      INSERT INTO student_assignments (student_id, course_id, lesson_id, teacher_id, title, instructions, due_date, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente')
      RETURNING *
    `, [
      student_id,
      course_id || null,
      lesson_id || null,
      teacherId,
      title.trim(),
      instructions || null,
      toISODate(due_date)
    ]);

    res.status(201).json({ message: 'Atividade cadastrada com sucesso!', assignment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envio da resposta / redação pela família do aluno (ou pela coordenação)
app.post('/api/assignments/:id/submit', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { submission_text } = req.body;
    const attachment_url = req.body.attachment_url || req.body.submission_attachment_url || null;
    if (!['responsavel', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Apenas o aluno/família pode enviar a atividade.' });
    }
    if ((!submission_text || !String(submission_text).trim()) && !attachment_url) {
      return res.status(400).json({ error: 'Envie o texto da resposta ou anexo.' });
    }
    if (attachment_url && !/^https?:\/\//i.test(attachment_url)) {
      return res.status(400).json({ error: 'O link do anexo deve começar com http:// ou https://' });
    }

    const current = await pool.query('SELECT student_id, status FROM student_assignments WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Atividade não encontrada.' });
    if (req.user.role === 'responsavel' && String(current.rows[0].student_id) !== String(req.user.student_id)) {
      return res.status(403).json({ error: 'Acesso negado: esta atividade não pertence ao seu aluno.' });
    }
    if (current.rows[0].status === 'corrigido') {
      return res.status(400).json({ error: 'Esta atividade já foi corrigida e não aceita novo envio.' });
    }

    const result = await pool.query(`
      UPDATE student_assignments
      SET submission_text = $1,
          attachment_url = $2,
          status = 'enviado',
          submitted_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [submission_text ? String(submission_text).trim() : null, attachment_url, id]);

    res.json({ message: 'Atividade enviada para correção do professor com sucesso!', assignment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Correção e atribuição de nota pelo professor ou admin
app.post('/api/assignments/:id/grade', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const { id } = req.params;
    const { grade, teacher_feedback } = req.body;
    const numericGrade = Number(grade);
    if (grade === undefined || grade === null || grade === '' || isNaN(numericGrade) || numericGrade < 0 || numericGrade > 10) {
      return res.status(400).json({ error: 'A nota deve ser um número de 0 a 10.' });
    }

    const current = await pool.query('SELECT student_id, teacher_id, status FROM student_assignments WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Atividade não encontrada.' });
    const a = current.rows[0];
    if (req.user.role === 'professor') {
      const isMine = a.teacher_id === req.user.id || (a.teacher_id === null && await teacherCanAccessStudent(req.user.id, a.student_id));
      if (!isMine) return res.status(403).json({ error: 'Acesso negado: esta atividade é de outro professor.' });
    }
    if (a.status === 'pendente') {
      return res.status(400).json({ error: 'O aluno ainda não enviou esta atividade.' });
    }

    const result = await pool.query(`
      UPDATE student_assignments
      SET grade = $1,
          teacher_feedback = $2,
          teacher_id = COALESCE(teacher_id, $3),
          status = 'corrigido',
          graded_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [Math.round(numericGrade * 10) / 10, teacher_feedback || null, req.user.id, id]);

    res.json({ message: 'Correção registrada com sucesso!', assignment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// 💳 MÓDULO: SISTEMA FINANCEIRO ESCOLAR & PIX
// ========================================================

// Código Pix de DEMONSTRAÇÃO: a chave é fictícia e nenhum banco aceita este código.
function generatePixPayload(amount, invoiceNumber) {
  const amtStr = Number(amount || 0).toFixed(2);
  const cleanInv = String(invoiceNumber || 'ENTRELINHAS').replace(/[^a-zA-Z0-9]/g, '');
  return `00020126580014br.gov.bcb.pix0136comercial@entrelinhas.online520400005303986540${amtStr}5802BR5925ESCOLA ENTRELINHAS LTDA6008CAMBORIU62140510${cleanInv.substring(0, 10)}6304${Math.floor(1000 + Math.random() * 9000)}`;
}

// Dashboard Financeiro Executivo (Admin)
app.get('/api/financial/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const totalsRes = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pago' AND date_trunc('month', paid_date) = date_trunc('month', CURRENT_DATE) THEN net_amount ELSE 0 END), 0) as month_received,
        COALESCE(SUM(CASE WHEN status = 'pendente' AND due_date >= CURRENT_DATE THEN net_amount ELSE 0 END), 0) as to_receive,
        COALESCE(SUM(CASE WHEN status = 'pendente' AND due_date < CURRENT_DATE THEN net_amount ELSE 0 END), 0) as overdue_amount,
        COALESCE(SUM(CASE WHEN date_trunc('month', due_date) = date_trunc('month', CURRENT_DATE) THEN net_amount ELSE 0 END), 0) as month_expected,
        COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE THEN net_amount ELSE 0 END), 0) as matured_amount,
        COUNT(CASE WHEN status = 'pago' THEN 1 END) as paid_count,
        COUNT(CASE WHEN status = 'pendente' AND due_date >= CURRENT_DATE THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'pendente' AND due_date < CURRENT_DATE THEN 1 END) as overdue_count
      FROM invoices
      WHERE status != 'cancelado'
    `);

    const summary = totalsRes.rows[0];
    const overdueAmount = parseFloat(summary.overdue_amount || 0);
    const maturedAmount = parseFloat(summary.matured_amount || 0);

    // Inadimplência = valor vencido e não pago ÷ tudo o que já venceu (pago ou não)
    const inadimplenciaRate = maturedAmount > 0 ? ((overdueAmount / maturedAmount) * 100).toFixed(1) : 0;

    const recentRes = await pool.query(`
      SELECT
        i.*,
        st.name as student_name,
        st.parent_name,
        st.parent_phone,
        TO_CHAR(i.due_date, 'DD/MM/YYYY') as formatted_due_date,
        TO_CHAR(i.paid_date, 'DD/MM/YYYY') as formatted_paid_date
      FROM invoices i
      JOIN students st ON st.id = i.student_id
      ORDER BY i.created_at DESC
      LIMIT 10
    `);

    const trendRes = await pool.query(`
      SELECT
        TO_CHAR(date_trunc('month', due_date), 'TMMon/YY') as month_label,
        date_trunc('month', due_date) as month_date,
        COALESCE(SUM(CASE WHEN status = 'pago' THEN net_amount ELSE 0 END), 0) as received,
        COALESCE(SUM(net_amount), 0) as total
      FROM invoices
      WHERE due_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months' AND status != 'cancelado'
      GROUP BY date_trunc('month', due_date)
      ORDER BY month_date ASC
    `);

    res.json({
      summary: {
        month_received: parseFloat(summary.month_received || 0),
        to_receive: parseFloat(summary.to_receive || 0),
        overdue_amount: overdueAmount,
        month_expected: parseFloat(summary.month_expected || 0),
        paid_count: parseInt(summary.paid_count || 0),
        pending_count: parseInt(summary.pending_count || 0),
        overdue_count: parseInt(summary.overdue_count || 0),
        inadimplencia_rate: Number(inadimplenciaRate)
      },
      recent_invoices: recentRes.rows,
      trend: trendRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listagem detalhada de faturas com filtros (Admin)
app.get('/api/financial/invoices', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { status, student_id, search } = req.query;
    let query = `
      SELECT
        i.*,
        st.name as student_name,
        st.parent_name,
        st.parent_phone,
        st.parent_email,
        TO_CHAR(i.due_date, 'DD/MM/YYYY') as formatted_due_date,
        TO_CHAR(i.paid_date, 'DD/MM/YYYY') as formatted_paid_date,
        CASE
          WHEN i.status = 'pendente' AND i.due_date < CURRENT_DATE THEN 'atrasado'
          ELSE i.status
        END as current_status
      FROM invoices i
      JOIN students st ON st.id = i.student_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      if (status === 'atrasado') {
        query += ` AND i.status = 'pendente' AND i.due_date < CURRENT_DATE`;
      } else if (status === 'pendente') {
        query += ` AND i.status = 'pendente' AND i.due_date >= CURRENT_DATE`;
      } else {
        params.push(status);
        query += ` AND i.status = $${params.length}`;
      }
    }

    if (student_id) {
      params.push(student_id);
      query += ` AND i.student_id = $${params.length}`;
    }

    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      query += ` AND (LOWER(st.name) LIKE $${params.length} OR LOWER(i.title) LIKE $${params.length} OR LOWER(i.invoice_number) LIKE $${params.length})`;
    }

    query += ` ORDER BY i.due_date DESC, i.id DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const VALID_PAYMENT_METHODS = ['pix', 'boleto', 'cartao', 'dinheiro'];

// Cadastrar nova fatura (Admin)
app.post('/api/financial/invoices', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { student_id, title, description, amount, discount, due_date, payment_method, notes, plan_id } = req.body;
    if (!student_id || !title || !String(title).trim() || amount === undefined || amount === null || amount === '' || !due_date) {
      return res.status(400).json({ error: 'Aluno, título, valor e vencimento são obrigatórios.' });
    }

    const numAmt = parseFloat(amount);
    const numDisc = parseFloat(discount || 0);
    if (!(numAmt > 0)) return res.status(400).json({ error: 'O valor da fatura deve ser maior que zero.' });
    if (isNaN(numDisc) || numDisc < 0) return res.status(400).json({ error: 'O desconto não pode ser negativo.' });
    if (numDisc >= numAmt) return res.status(400).json({ error: 'O desconto precisa ser menor que o valor da fatura.' });
    const dueIso = toISODate(due_date);
    if (!dueIso) return res.status(400).json({ error: 'Data de vencimento inválida.' });
    if (payment_method && !VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: 'Forma de pagamento inválida.' });
    }
    const st = await client.query('SELECT id, status FROM students WHERE id = $1', [student_id]);
    if (st.rows.length === 0) return res.status(400).json({ error: 'Aluno não encontrado.' });
    if (st.rows[0].status !== 'ativo') return res.status(400).json({ error: 'Não é possível gerar fatura para aluno inativo.' });

    const netAmount = Math.round((numAmt - numDisc) * 100) / 100;

    await client.query('BEGIN');
    const inserted = await client.query(`
      INSERT INTO invoices
        (invoice_number, student_id, plan_id, title, description, amount, discount, net_amount, due_date, payment_method, status, notes)
      VALUES ('TEMP-' || md5(random()::text), $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'pix'), 'pendente', $10)
      RETURNING id
    `, [student_id, plan_id || null, title.trim(), description || null, numAmt, numDisc, netAmount, dueIso, payment_method || null, notes || null]);

    // Número sequencial único (FAT-AAAAMM-000123), derivado do id da fatura
    const invId = inserted.rows[0].id;
    const invoiceNumber = `FAT-${dueIso.slice(0, 4)}${dueIso.slice(5, 7)}-${String(invId).padStart(6, '0')}`;
    const result = await client.query(
      'UPDATE invoices SET invoice_number = $1, pix_code = $2 WHERE id = $3 RETURNING *',
      [invoiceNumber, generatePixPayload(netAmount, invoiceNumber), invId]
    );
    await client.query('COMMIT');

    res.status(201).json({ message: 'Fatura gerada com sucesso!', invoice: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Baixar fatura como paga (Admin 1-Clique) — só faturas pendentes
app.patch('/api/financial/invoices/:id/pay', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_method } = req.body;
    if (payment_method && !VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: 'Forma de pagamento inválida.' });
    }

    const current = await pool.query('SELECT status FROM invoices WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Fatura não encontrada.' });
    if (current.rows[0].status !== 'pendente') {
      return res.status(400).json({ error: `Só faturas pendentes podem ser baixadas. Esta fatura está "${current.rows[0].status}".` });
    }

    const receiptNumber = `REC-${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()).replace(/-/g, '')}-${id}`;

    const result = await pool.query(`
      UPDATE invoices
      SET status = 'pago',
          paid_date = CURRENT_DATE,
          payment_method = COALESCE($1, payment_method, 'pix'),
          receipt_number = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND status = 'pendente'
      RETURNING *
    `, [payment_method || null, receiptNumber, id]);

    if (result.rows.length === 0) return res.status(409).json({ error: 'A fatura mudou de status. Atualize a tela e tente de novo.' });
    res.json({ message: 'Pagamento confirmado e recibo emitido com sucesso!', invoice: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancelar fatura (Admin) — só faturas pendentes; fatura paga não é cancelada
app.patch('/api/financial/invoices/:id/cancel', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const current = await pool.query('SELECT status FROM invoices WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Fatura não encontrada.' });
    if (current.rows[0].status !== 'pendente') {
      return res.status(400).json({ error: `Só faturas pendentes podem ser canceladas. Esta fatura está "${current.rows[0].status}".` });
    }
    const result = await pool.query(`
      UPDATE invoices
      SET status = 'cancelado', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'pendente'
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) return res.status(409).json({ error: 'A fatura mudou de status. Atualize a tela e tente de novo.' });
    res.json({ message: 'Fatura cancelada com sucesso.', invoice: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Faturas da família logada (Portal da Família / Aluno)
app.get('/api/student/invoices', authenticateToken, async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.query.student_id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const studentId = scope.studentId;

    const result = await pool.query(`
      SELECT 
        i.*,
        st.name as student_name,
        TO_CHAR(i.due_date, 'DD/MM/YYYY') as formatted_due_date,
        TO_CHAR(i.paid_date, 'DD/MM/YYYY') as formatted_paid_date,
        CASE 
          WHEN i.status = 'pendente' AND i.due_date < CURRENT_DATE THEN 'atrasado'
          ELSE i.status 
        END as current_status
      FROM invoices i
      JOIN students st ON st.id = i.student_id
      WHERE i.student_id = $1 AND i.status != 'cancelado'
      ORDER BY 
        CASE WHEN i.status = 'pendente' THEN 1 ELSE 2 END,
        i.due_date DESC
    `, [studentId]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Planos financeiros cadastrados
app.get('/api/financial/plans', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM financial_plans WHERE status = 'ativo' ORDER BY id ASC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// 📋 RELATÓRIO DE ACOMPANHAMENTO PEDAGÓGICO (FICHA DO PROFESSOR)
// ========================================================

// Opções válidas de cada bloco da ficha (as mesmas do formulário impresso)
const PED_OPTIONS = {
  objectives: ['leitura', 'interpretacao', 'producao_textual', 'ortografia', 'matematica', 'raciocinio_logico', 'organizacao_estudos', 'enem_vestibulares', 'outros'],
  performanceComponents: ['portugues', 'matematica', 'interpretacao', 'producao_textual', 'raciocinio_logico', 'outros'],
  levels: ['otimo', 'bom', 'regular', 'em_desenvolvimento'],
  behaviorAspects: ['participacao', 'concentracao', 'organizacao', 'autonomia', 'relacionamento', 'persistencia'],
  strategies: ['ludicas', 'recursos_digitais', 'lousa_digital', 'exercicios_personalizados', 'gamificacao', 'acompanhamento_individualizado', 'material_adaptado', 'outros'],
  emotional: ['aceita_orientacoes', 'necessita_redirecionamento', 'tolerancia_frustracao', 'resistencia_inicial', 'interage_respeitosa', 'outros']
};

const PED_SELECT = `
  SELECT pr.*,
    st.name AS student_name,
    COALESCE(u.name, pr.teacher_name) AS teacher_display_name,
    to_char(pr.report_date, 'DD/MM/YYYY') AS report_date_br,
    to_char(pr.period_start, 'DD/MM/YYYY') AS period_start_br,
    to_char(pr.period_end, 'DD/MM/YYYY') AS period_end_br,
    to_char(pr.updated_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24"h"MI"m"') AS updated_at_br
  FROM pedagogical_reports pr
  JOIN students st ON st.id = pr.student_id
  LEFT JOIN users u ON u.id = pr.teacher_id
`;

/** Valida e normaliza o corpo do relatório. Retorna { error } ou { data }. */
function normalizePedagogicalReport(body) {
  const pickList = (value, allowed) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const clean = [...new Set(value.map(String))];
    return clean.every(v => allowed.includes(v)) ? clean : null;
  };
  const text = (v, max = 5000) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

  const objectives = pickList(body.objectives, PED_OPTIONS.objectives);
  if (!objectives) return { error: 'Objetivos trabalhados inválidos.' };
  const behaviorAspects = pickList(body.behavior_aspects, PED_OPTIONS.behaviorAspects);
  if (!behaviorAspects) return { error: 'Aspectos comportamentais inválidos.' };
  const strategies = pickList(body.strategies, PED_OPTIONS.strategies);
  if (!strategies) return { error: 'Estratégias utilizadas inválidas.' };
  const emotional = pickList(body.emotional_behaviors, PED_OPTIONS.emotional);
  if (!emotional) return { error: 'Comportamentos observados inválidos.' };

  const performance = {};
  if (body.performance && typeof body.performance === 'object') {
    for (const [component, level] of Object.entries(body.performance)) {
      if (!level) continue;
      if (!PED_OPTIONS.performanceComponents.includes(component) || !PED_OPTIONS.levels.includes(level)) {
        return { error: 'Desempenho acadêmico inválido.' };
      }
      performance[component] = level;
    }
  }

  if (body.behavior_overall && !PED_OPTIONS.levels.includes(body.behavior_overall)) {
    return { error: 'Avaliação geral dos aspectos comportamentais inválida.' };
  }

  const reportDate = body.report_date ? toISODate(body.report_date) : getSaoPauloNow().dateStr;
  if (!reportDate) return { error: 'Data do relatório inválida.' };
  const periodStart = body.period_start ? toISODate(body.period_start) : null;
  const periodEnd = body.period_end ? toISODate(body.period_end) : null;
  if ((body.period_start && !periodStart) || (body.period_end && !periodEnd)) return { error: 'Período avaliado inválido.' };
  if (periodStart && periodEnd && periodEnd < periodStart) return { error: 'O fim do período avaliado não pode ser antes do início.' };

  let lessonsCount = null;
  if (body.lessons_count !== undefined && body.lessons_count !== null && body.lessons_count !== '') {
    lessonsCount = parseInt(body.lessons_count);
    if (!(lessonsCount >= 0 && lessonsCount <= 1000)) return { error: 'Número de aulas no período inválido.' };
  }

  const status = body.status || 'rascunho';
  if (!['rascunho', 'finalizado'].includes(status)) return { error: 'Status do relatório inválido.' };

  const data = {
    report_date: reportDate,
    student_age: text(body.student_age, 30),
    class_info: text(body.class_info, 150),
    period_start: periodStart,
    period_end: periodEnd,
    lessons_count: lessonsCount,
    objectives,
    objectives_other: objectives.includes('outros') ? text(body.objectives_other, 200) : null,
    academic_development: text(body.academic_development),
    performance,
    performance_other_label: performance.outros ? text(body.performance_other_label, 100) : null,
    academic_notes: text(body.academic_notes),
    behavior_overall: body.behavior_overall || null,
    behavior_aspects: behaviorAspects,
    behavior_notes: text(body.behavior_notes),
    strategies,
    strategies_other: strategies.includes('outros') ? text(body.strategies_other, 200) : null,
    evolution: text(body.evolution),
    emotional_behaviors: emotional,
    emotional_other: emotional.includes('outros') ? text(body.emotional_other, 200) : null,
    emotional_notes: text(body.emotional_notes),
    family_recommendations: text(body.family_recommendations),
    school_suggestions: text(body.school_suggestions),
    final_considerations: text(body.final_considerations),
    status
  };

  // Para finalizar (e ficar visível à família), o relatório precisa do essencial preenchido
  if (status === 'finalizado') {
    const missing = [];
    if (!data.period_start || !data.period_end) missing.push('período avaliado');
    if (data.objectives.length === 0) missing.push('objetivos trabalhados');
    if (!data.academic_development) missing.push('desenvolvimento acadêmico');
    if (Object.keys(data.performance).length === 0) missing.push('desempenho acadêmico');
    if (!data.behavior_overall) missing.push('avaliação geral dos aspectos comportamentais');
    if (missing.length > 0) {
      return { error: `Para finalizar o relatório, preencha: ${missing.join(', ')}. Você pode salvar como rascunho e completar depois.` };
    }
  }
  return { data };
}

const PED_COLUMNS = [
  'report_date', 'student_age', 'class_info', 'period_start', 'period_end', 'lessons_count',
  'objectives', 'objectives_other', 'academic_development', 'performance', 'performance_other_label',
  'academic_notes', 'behavior_overall', 'behavior_aspects', 'behavior_notes', 'strategies',
  'strategies_other', 'evolution', 'emotional_behaviors', 'emotional_other', 'emotional_notes',
  'family_recommendations', 'school_suggestions', 'final_considerations', 'status'
];
const PED_JSON_COLUMNS = ['objectives', 'performance', 'behavior_aspects', 'strategies', 'emotional_behaviors'];
const pedValue = (data, col) => (PED_JSON_COLUMNS.includes(col) ? JSON.stringify(data[col]) : data[col]);

// Relatórios de um aluno (família vê só os finalizados)
app.get('/api/students/:id/pedagogical-reports', authenticateToken, async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.params.id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const onlyFinal = req.user.role === 'responsavel';
    const result = await pool.query(
      `${PED_SELECT} WHERE pr.student_id = $1 ${onlyFinal ? "AND pr.status = 'finalizado'" : ''} ORDER BY pr.report_date DESC, pr.id DESC`,
      [scope.studentId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sugestões para preencher o cabeçalho: nº de aulas no período (pelo diário) e turma/horário (pela grade)
app.get('/api/students/:id/pedagogical-reports/suggestion', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.params.id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const start = toISODate(req.query.period_start);
    const end = toISODate(req.query.period_end);

    let lessonsCount = null;
    if (start && end) {
      const params = [scope.studentId, start, end];
      let teacherFilter = '';
      if (req.user.role === 'professor') {
        params.push(req.user.id);
        teacherFilter = 'AND teacher_id = $4';
      }
      const r = await pool.query(
        `SELECT COUNT(*) FROM class_logs WHERE student_id = $1 AND class_date BETWEEN $2::date AND $3::date ${teacherFilter}`,
        params
      );
      lessonsCount = parseInt(r.rows[0].count);
    }

    const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const schedParams = [scope.studentId];
    let schedFilter = '';
    if (req.user.role === 'professor') {
      schedParams.push(req.user.id);
      schedFilter = 'AND ts.teacher_id = $2';
    }
    const sched = await pool.query(`
      SELECT ts.day_of_week, ts.start_time, ts.end_time, sub.name AS subject_name
      FROM teacher_schedules ts
      LEFT JOIN subjects sub ON sub.id = ts.subject_id
      WHERE ts.student_id = $1 AND ts.status = 'ativo' ${schedFilter}
      ORDER BY ts.day_of_week, ts.start_time
    `, schedParams);
    const classInfo = sched.rows
      .map(s => `${s.subject_name || 'Aula'} · ${dayNames[s.day_of_week]} ${s.start_time}`)
      .join(' | ');

    res.json({ lessons_count: lessonsCount, class_info: classInfo || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Um relatório específico
app.get('/api/pedagogical-reports/:id', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(`${PED_SELECT} WHERE pr.id = $1`, [req.params.id]);
    const report = r.rows[0];
    if (!report) return res.status(404).json({ error: 'Relatório não encontrado.' });
    const scope = await resolveStudentScope(req, report.student_id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    if (req.user.role === 'responsavel' && report.status !== 'finalizado') {
      return res.status(404).json({ error: 'Relatório não encontrado.' });
    }
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar relatório (professor para os seus alunos; admin para qualquer aluno)
app.post('/api/students/:id/pedagogical-reports', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.params.id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const st = await pool.query('SELECT id FROM students WHERE id = $1', [scope.studentId]);
    if (st.rows.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

    const norm = normalizePedagogicalReport(req.body);
    if (norm.error) return res.status(400).json({ error: norm.error });

    // O admin pode registrar em nome de um professor; o professor sempre assina como ele mesmo
    let teacherId = req.user.id;
    let teacherName = req.user.name;
    if (req.user.role === 'admin' && req.body.teacher_id) {
      const t = await pool.query("SELECT id, name FROM users WHERE id = $1 AND role = 'professor'", [req.body.teacher_id]);
      if (t.rows.length === 0) return res.status(400).json({ error: 'Professor informado não encontrado.' });
      teacherId = t.rows[0].id;
      teacherName = t.rows[0].name;
    }

    const cols = ['student_id', 'teacher_id', 'teacher_name', ...PED_COLUMNS];
    const values = [scope.studentId, teacherId, teacherName, ...PED_COLUMNS.map(c => pedValue(norm.data, c))];
    const placeholders = cols.map((c, i) => (PED_JSON_COLUMNS.includes(c) ? `$${i + 1}::jsonb` : `$${i + 1}`));
    const inserted = await pool.query(
      `INSERT INTO pedagogical_reports (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
      values
    );
    const full = await pool.query(`${PED_SELECT} WHERE pr.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({
      message: norm.data.status === 'finalizado' ? 'Relatório finalizado e disponível para a família!' : 'Rascunho do relatório salvo!',
      report: full.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function loadOwnPedagogicalReport(req, res) {
  const r = await pool.query('SELECT * FROM pedagogical_reports WHERE id = $1', [req.params.id]);
  const report = r.rows[0];
  if (!report) { res.status(404).json({ error: 'Relatório não encontrado.' }); return null; }
  if (req.user.role !== 'admin' && report.teacher_id !== req.user.id) {
    res.status(403).json({ error: 'Acesso negado: você só pode alterar relatórios escritos por você.' });
    return null;
  }
  return report;
}

// Editar relatório (autor ou admin)
app.put('/api/pedagogical-reports/:id', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const current = await loadOwnPedagogicalReport(req, res);
    if (!current) return;
    const norm = normalizePedagogicalReport(req.body);
    if (norm.error) return res.status(400).json({ error: norm.error });

    const sets = PED_COLUMNS.map((c, i) => `${c} = $${i + 1}${PED_JSON_COLUMNS.includes(c) ? '::jsonb' : ''}`);
    const values = PED_COLUMNS.map(c => pedValue(norm.data, c));
    values.push(current.id);
    await pool.query(
      `UPDATE pedagogical_reports SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length}`,
      values
    );
    const full = await pool.query(`${PED_SELECT} WHERE pr.id = $1`, [current.id]);
    res.json({
      message: norm.data.status === 'finalizado' ? 'Relatório finalizado e disponível para a família!' : 'Rascunho do relatório atualizado!',
      report: full.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Excluir relatório (autor ou admin)
app.delete('/api/pedagogical-reports/:id', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const current = await loadOwnPedagogicalReport(req, res);
    if (!current) return;
    await pool.query('DELETE FROM pedagogical_reports WHERE id = $1', [current.id]);
    res.json({ message: 'Relatório excluído.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// ✉️ MENSAGENS DA FAMÍLIA (PAIS → PROFESSOR OU COORDENAÇÃO)
// ========================================================

const FAMILY_MSG_SELECT = `
  SELECT fm.*,
    to_char(fm.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24"h"MI"m"') AS created_at_br,
    to_char(fm.replied_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24"h"MI"m"') AS replied_at_br,
    st.name AS student_name,
    t.name AS teacher_name
  FROM family_messages fm
  JOIN students st ON st.id = fm.student_id
  LEFT JOIN users t ON t.id = fm.teacher_id
`;

// Destinatários que a família pode escolher: coordenação + professores que dão aula ao aluno
app.get('/api/parent/message-recipients', authenticateToken, requireRole('responsavel'), async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const r = await pool.query(`
      SELECT DISTINCT u.id, u.name
      FROM users u
      WHERE u.role = 'professor' AND u.status = 'ativo' AND (
        u.id = (SELECT assigned_teacher_id FROM students WHERE id = $1)
        OR u.id IN (SELECT teacher_id FROM teacher_schedules WHERE student_id = $1 AND status = 'ativo')
      )
      ORDER BY u.name
    `, [studentId]);
    res.json({
      coordenacao: { label: 'Coordenação pedagógica' },
      professores: r.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mensagens enviadas pela família do aluno (com a resposta, quando houver)
app.get('/api/parent/messages', authenticateToken, requireRole('responsavel'), async (req, res) => {
  try {
    const r = await pool.query(`${FAMILY_MSG_SELECT} WHERE fm.student_id = $1 ORDER BY fm.created_at DESC, fm.id DESC`, [req.user.student_id]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Família envia mensagem ao professor (escolhido entre os do aluno) ou à coordenação
app.post('/api/parent/messages', authenticateToken, requireRole('responsavel'), async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const { recipient_type, teacher_id } = req.body;
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';

    if (!['professor', 'coordenacao'].includes(recipient_type)) {
      return res.status(400).json({ error: 'Escolha se a mensagem é para o professor ou para a coordenação.' });
    }
    if (body.length < 2) return res.status(400).json({ error: 'Escreva a mensagem antes de enviar.' });
    if (body.length > 1000) return res.status(400).json({ error: 'A mensagem pode ter no máximo 1000 caracteres.' });

    let teacherId = null;
    if (recipient_type === 'professor') {
      teacherId = parseInt(teacher_id);
      const allowed = await pool.query(`
        SELECT 1 FROM users u
        WHERE u.id = $2 AND u.role = 'professor' AND u.status = 'ativo' AND (
          u.id = (SELECT assigned_teacher_id FROM students WHERE id = $1)
          OR u.id IN (SELECT teacher_id FROM teacher_schedules WHERE student_id = $1 AND status = 'ativo')
        )`, [studentId, teacherId]);
      if (allowed.rows.length === 0) {
        return res.status(400).json({ error: 'Esse professor não dá aula ao aluno. Escolha outro destinatário.' });
      }
    }

    // Só grava o id de usuário se for uma conta de verdade (o acesso pelo código não tem conta)
    const parentUserId = req.user.id && req.user.id < 10000 ? req.user.id : null;
    const inserted = await pool.query(`
      INSERT INTO family_messages (student_id, parent_user_id, parent_name, recipient_type, teacher_id, body, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'nova') RETURNING id
    `, [studentId, parentUserId, req.user.name, recipient_type, teacherId, body]);
    const full = await pool.query(`${FAMILY_MSG_SELECT} WHERE fm.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ message: 'Mensagem enviada! A equipe responderá por aqui.', item: full.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Equipe vê as mensagens do aluno: admin vê todas; professor vê as endereçadas a ele
app.get('/api/students/:id/family-messages', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const scope = await resolveStudentScope(req, req.params.id);
    if (scope.error) return res.status(scope.status).json({ error: scope.error });
    const params = [scope.studentId];
    let filter = '';
    if (req.user.role === 'professor') {
      params.push(req.user.id);
      filter = `AND fm.recipient_type = 'professor' AND fm.teacher_id = $2`;
    }
    const r = await pool.query(`${FAMILY_MSG_SELECT} WHERE fm.student_id = $1 ${filter} ORDER BY fm.created_at DESC, fm.id DESC`, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function loadFamilyMessageForStaff(req, res) {
  const r = await pool.query('SELECT * FROM family_messages WHERE id = $1', [req.params.id]);
  const msg = r.rows[0];
  if (!msg) { res.status(404).json({ error: 'Mensagem não encontrada.' }); return null; }
  const canSee = req.user.role === 'admin' || (msg.recipient_type === 'professor' && msg.teacher_id === req.user.id);
  if (!canSee) { res.status(403).json({ error: 'Acesso negado: esta mensagem é de outro destinatário.' }); return null; }
  return msg;
}

// Equipe marca a mensagem como lida
app.post('/api/family-messages/:id/read', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const msg = await loadFamilyMessageForStaff(req, res);
    if (!msg) return;
    await pool.query(
      "UPDATE family_messages SET status = CASE WHEN status = 'nova' THEN 'lida' ELSE status END, read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = $1",
      [msg.id]
    );
    res.json({ message: 'Mensagem marcada como lida.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Equipe responde à família (a resposta aparece para a família no Portal)
app.post('/api/family-messages/:id/reply', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const msg = await loadFamilyMessageForStaff(req, res);
    if (!msg) return;
    const reply = typeof req.body.reply === 'string' ? req.body.reply.trim() : '';
    if (reply.length < 2) return res.status(400).json({ error: 'Escreva a resposta antes de enviar.' });
    if (reply.length > 2000) return res.status(400).json({ error: 'A resposta pode ter no máximo 2000 caracteres.' });
    await pool.query(`
      UPDATE family_messages
      SET reply = $1, reply_by = $2, reply_by_name = $3, replied_at = CURRENT_TIMESTAMP,
          status = 'respondida', read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE id = $4
    `, [reply, req.user.id, req.user.name, msg.id]);
    const full = await pool.query(`${FAMILY_MSG_SELECT} WHERE fm.id = $1`, [msg.id]);
    res.json({ message: 'Resposta enviada para a família.', item: full.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mensagens da família que ainda aguardam resposta, para o painel de quem precisa responder.
// Admin (coordenação): todas as pendentes (para a coordenação e para qualquer professor).
// Professor: só as endereçadas a ele.
app.get('/api/family-messages/pending', authenticateToken, requireRole('admin', 'professor'), async (req, res) => {
  try {
    const params = [];
    let filter = '';
    if (req.user.role === 'professor') {
      params.push(req.user.id);
      filter = `AND fm.recipient_type = 'professor' AND fm.teacher_id = $1`;
    }
    const r = await pool.query(`
      SELECT fm.id, fm.student_id, fm.recipient_type, fm.teacher_id, fm.status, fm.body,
        st.name AS student_name,
        t.name AS teacher_name,
        to_char(fm.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY - HH24"h"MI"m"') AS created_at_br
      FROM family_messages fm
      JOIN students st ON st.id = fm.student_id AND st.status = 'ativo'
      LEFT JOIN users t ON t.id = fm.teacher_id
      WHERE fm.status <> 'respondida' ${filter}
      ORDER BY fm.created_at ASC
      LIMIT 50
    `, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Erros inesperados ficam registrados no log em vez de derrubar o servidor
process.on('unhandledRejection', (reason) => {
  console.error(' Erro assíncrono não tratado:', reason && reason.message ? reason.message : reason);
});

// Inicialização
async function startServer() {
  try {
    await initDB(seedData);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`=======================================================`);
      console.log(` App Diário de Classe Entrelinhas rodando na porta ${PORT}`);
      console.log(` Acesse no navegador/celular: http://localhost:${PORT}`);
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Falha crítica ao iniciar servidor:', err);
    process.exit(1);
  }
}

startServer();
