const { pool } = require('./db');

async function seedData() {
  const client = await pool.connect();
  try {
    const subjectsCount = await client.query('SELECT COUNT(*) FROM subjects');
    if (parseInt(subjectsCount.rows[0].count) > 0) {
      console.log(' Banco já contém dados. Pulando seed inicial.');
      return;
    }

    console.log(' Iniciando povoamento inicial do banco a partir da planilha...');
    await client.query('BEGIN');

    // 1. Inserir Matérias
    const subjectsMap = {};
    const subjects = [
      { code: 'port_concurso', name: 'Port.Concurso', gid: '1237128972' },
      { code: 'matematica_reforco', name: 'Matemática Reforço', gid: '449026475' },
      { code: 'informatica', name: 'Informática', gid: '907660519' },
      { code: 'portugues_reforco', name: 'Português Reforço', gid: '939191613' },
      { code: 'redacao', name: 'Redação', gid: '1490941798' },
    ];

    for (const sub of subjects) {
      const res = await client.query(
        'INSERT INTO subjects (code, name, sheet_gid) VALUES ($1, $2, $3) RETURNING id',
        [sub.code, sub.name, sub.gid]
      );
      subjectsMap[sub.code] = res.rows[0].id;
    }

    // Helper para criar aluno e associar à matéria
    async function addStudent(name, objective, startDate, endDate, subjectCodes) {
      const res = await client.query(
        'INSERT INTO students (name, objective_grade, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, objective || '', startDate || '', endDate || '']
      );
      const studentId = res.rows[0].id;
      for (const code of subjectCodes) {
        if (subjectsMap[code]) {
          await client.query(
            'INSERT INTO student_subjects (student_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [studentId, subjectsMap[code]]
          );
        }
      }
      return studentId;
    }

    // Helper para criar aula
    async function addLog(studentId, subjectCode, date, status, content, incidents, notes, teacher) {
      await client.query(
        `INSERT INTO class_logs (student_id, subject_id, class_date, class_time, status, content, incidents, pedagogical_notes, teacher_name)
         VALUES ($1, $2, $3, '07:30', $4, $5, $6, $7, $8)`,
        [
          studentId,
          subjectsMap[subjectCode],
          date,
          status,
          content || '',
          incidents || 'Sem intercorrências',
          notes || '',
          teacher || 'Luciano'
        ]
      );
    }

    // --- ALUNOS E AULAS EXTRAÍDOS DA PLANILHA ---

    // 1. Port.Concurso
    const sabrina = await addStudent('Sabrina Cristina Dognini', 'Concurso público', '28/04/2026', '', ['port_concurso', 'matematica_reforco']);
    await addLog(sabrina, 'port_concurso', '2026-05-06', 'presente', 'Interpretação de texto mais completa, ideia principal e secundária, inferência. Classes de palavras: Substantivo, verbo e ortografia', 'Sem intercorrências', 'Boa evolução nos conceitos', 'Luciano');
    await addLog(sabrina, 'port_concurso', '2026-05-11', 'presente', 'Conjunções verbais (modos e tempos), identificação de pessoas e números e resolução de questões de concurso', 'Sem intercorrências', 'Realizou resolução de questões com autonomia', 'Luciano');

    const ariani = await addStudent('Ariani Aparecida de Barros Andrade', 'Concurso público', '04/04/2026', '', ['port_concurso']);
    await addLog(ariani, 'port_concurso', '2026-09-03', 'presente', 'Aposto e Vocativo', 'Sem intercorrências', 'Conteúdo fixado', 'Luciano');
    await addLog(ariani, 'port_concurso', '2026-09-25', 'presente', 'Aposto e Vocativo - Aprofundamento', 'Sem intercorrências', 'Revisão aplicada', 'Luciano');

    const daniel = await addStudent('Daniel Lima dos Reis', 'Concurso público', '25/09/2025', '', ['port_concurso', 'matematica_reforco']);

    // 2. Matemática Reforço
    const nycolas = await addStudent('Nycolas Isair de Jesus Nascimento', 'Reforço / 1º Ano - 17 anos', '04/05/2026', '', ['matematica_reforco', 'informatica', 'portugues_reforco']);
    await addLog(nycolas, 'matematica_reforco', '2026-09-01', 'falta', '', 'Aluno faltou', 'Falta informada', 'Professor');
    await addLog(nycolas, 'matematica_reforco', '2026-09-08', 'falta', '', 'Aluno faltou', 'Falta', 'Professor');
    await addLog(nycolas, 'matematica_reforco', '2026-09-15', 'presente', 'Funções logarítmica e resolução de problemas', 'Sem intercorrências', 'Acompanhou a resolução', 'Professor');
    await addLog(nycolas, 'matematica_reforco', '2026-09-22', 'falta', '', 'Aluno faltou', 'Falta', 'Professor');

    // Nycolas em Português
    await addLog(nycolas, 'portugues_reforco', '2026-05-04', 'presente', 'Interpretação de texto. Leitura, compreensão textual e perguntas sobre o texto', 'Sem intercorrências', 'Participativo', 'Luciano');
    await addLog(nycolas, 'portugues_reforco', '2026-05-11', 'presente', 'Tempos verbais, conjugação, verbos regulares/irregulares, ação e estado', 'Sem intercorrências', 'Boa absorção de verbos', 'Luciano');
    await addLog(nycolas, 'portugues_reforco', '2026-09-14', 'falta', '', 'Aluno faltou', 'Falta', 'Luciano');

    const daviMatias = await addStudent('Davi Matias dos Santos Iurk', 'Física e Matemática', '11/08/2026', '', ['matematica_reforco', 'informatica', 'portugues_reforco']);
    await addLog(daviMatias, 'matematica_reforco', '2026-09-14', 'presente', 'Física: 1ª e 2ª leis da termodinâmica', 'Sem intercorrências', 'Compreendeu bem as fórmulas', 'Professor');
    await addLog(daviMatias, 'matematica_reforco', '2026-09-21', 'presente', 'Matemática: Revisão de conteúdo de matemática básica', 'Sem intercorrências', 'Revisão completa', 'Professor');
    await addLog(daviMatias, 'matematica_reforco', '2026-09-28', 'presente', 'Matemática: Revisão de união e interseção de probabilidades', 'Sem intercorrências', 'Boa evolução', 'Professor');
    await addLog(daviMatias, 'portugues_reforco', '2026-09-24', 'presente', 'Revisão para a prova de matemática: Frações, sistema monetário e divisão', 'Sem intercorrências', 'Focado na revisão', 'Professor');

    const enzo = await addStudent('Enzo Salvador Machado Moraes', '4ª série - 9 anos', '28/04/2026', '', ['matematica_reforco', 'portugues_reforco']);
    await addLog(enzo, 'matematica_reforco', '2026-08-21', 'presente', 'Sistema monetário utilizando lousa digital, jogos, material impresso e simulação de prova. Atividades de composição de valores com moedas e cédulas.', 'Dificuldade de concentração na leitura dos enunciados', 'Dificuldade na interpretação de enunciados. Recomenda-se reforçar leitura e operações de multiplicação/divisão', 'Sibele');
    await addLog(enzo, 'portugues_reforco', '2026-05-07', 'presente', 'Leitura de texto curto, interpretação simples, ortografia básica, separação de sílabas, substantivo e verbo', 'Sem intercorrências', 'Introdução satisfatória', 'Sibele');
    await addLog(enzo, 'portugues_reforco', '2026-09-03', 'presente', 'Revisão de interpretação, ortografia e ditado (X, CH, SS, J, G)', 'Dificuldade de escrita', 'Muita dificuldade em interpretar perguntas e em ortografia. Erros no ditado', 'Sibele');
    await addLog(enzo, 'portugues_reforco', '2026-09-10', 'presente', 'Interpretação de texto, sinônimos e antônimos, artigos e sílabas tônicas', 'Dificuldade visual notada', 'Acompanhar se a dificuldade em enxergar é da impressão ou visual', 'Sibele');
    await addLog(enzo, 'portugues_reforco', '2026-09-17', 'presente', 'Revisão para prova com sinônimos, antônimos e adjetivos', 'Sem intercorrências', 'Preparação para prova', 'Sibele');
    await addLog(enzo, 'portugues_reforco', '2026-09-24', 'presente', 'Continuação da revisão para a prova', 'Dificuldade de memorização', 'Tem bom desenvolvimento após ser situado no assunto', 'Sibele');

    const luiza = await addStudent('Luiza da Silva Fontela', 'Matemática', '18/08/2026', '22/09/2026', ['matematica_reforco']);
    const marco = await addStudent('Marco Aurelio Teodoro Junior', 'Reforço', '26/05/2026', '', ['matematica_reforco', 'portugues_reforco']);
    await addLog(marco, 'portugues_reforco', '2026-09-14', 'falta', '', 'Aluno faltou', 'Falta registrada', 'Professor');

    const isabela = await addStudent('Isabela Rampelotto Goudinho', '5ª série - 10 anos', '15/06/2026', '', ['matematica_reforco', 'portugues_reforco']);
    await addLog(isabela, 'portugues_reforco', '2026-08-26', 'presente', 'Separação de sílabas e identificação de sílabas tônicas. Vídeo e lousa digital.', 'Sem intercorrências', 'Demonstrou interesse, necessita maior atenção à leitura dos enunciados', 'Sibele');
    await addLog(isabela, 'portugues_reforco', '2026-09-03', 'presente', 'As versões de Chapeuzinho Vermelho', 'Sem intercorrências', 'Produção textual ativa', 'Professor');
    await addLog(isabela, 'portugues_reforco', '2026-09-09', 'presente', 'Produção de texto: O mistério da mochila abandonada', 'Sem intercorrências', 'Excelente criatividade', 'Professor');

    const rafaelly = await addStudent('Rafaelly Bernardi de Oliveira', '3º ano - 8 anos', '22/05/2026', '', ['matematica_reforco', 'portugues_reforco']);
    await addLog(rafaelly, 'portugues_reforco', '2026-08-20', 'presente', 'Classificação de palavras (ação, estado ou fenômeno da natureza)', 'Sinais de sono e cansaço', 'Respondeu bem às propostas com apoio e mediação', 'Sibele');
    await addLog(rafaelly, 'portugues_reforco', '2026-08-27', 'presente', 'Reconhecimento de palavras com S e SS. Material didático UNO', 'Sem intercorrências', 'Demonstrou interesse e participação', 'Sibele');
    await addLog(rafaelly, 'portugues_reforco', '2026-09-03', 'presente', 'Revisão de interpretação, ortografia e ditado (X, CH, SS, J, G)', 'Sem intercorrências', 'Acertou a grande maioria no ditado. Grande melhora', 'Sibele');
    await addLog(rafaelly, 'portugues_reforco', '2026-09-10', 'presente', 'Pronomes pessoais e possessivos e interpretação simples', 'Sem intercorrências', 'Melhorou na leitura e atenção', 'Sibele');
    await addLog(rafaelly, 'portugues_reforco', '2026-09-17', 'falta', '', 'Aluno faltou', 'Falta', 'Sibele');
    await addLog(rafaelly, 'portugues_reforco', '2026-09-24', 'presente', 'Uso do til (~), pronomes no cotidiano e acentuação', 'Reclama de cansaço', 'Dificuldade em oxítonas/paroxítonas, mas evoluiu bastante', 'Sibele');

    const kaune = await addStudent('Kaune Provenzi da Silva', '1ª série', '01/09/2026', '', ['matematica_reforco']);
    await addLog(kaune, 'matematica_reforco', '2026-09-01', 'presente', 'Propriedades logarítmicas e resolução de exercícios', 'Sem intercorrências', 'Bom aproveitamento', 'Professor');
    await addLog(kaune, 'matematica_reforco', '2026-09-08', 'presente', 'Funções logarítmicas e resolução de problemas', 'Sem intercorrências', 'Exercícios concluídos', 'Professor');
    await addLog(kaune, 'matematica_reforco', '2026-09-15', 'presente', 'Continuação de Funções logarítmicas e revisão', 'Sem intercorrências', 'Dúvidas sanadas', 'Professor');
    await addLog(kaune, 'matematica_reforco', '2026-09-22', 'presente', 'Área de figuras planas e situações-problema', 'Sem intercorrências', 'Evolução consistente', 'Professor');

    const daviAntonio = await addStudent('Davi Antonio Lemes de Oliveira', 'Reforço', '17/06/2026', '', ['matematica_reforco', 'portugues_reforco']);

    // 3. Informática
    const gabriel = await addStudent('Gabriel Porciúncula', 'Informática Básica', '10/11/2025', '', ['informatica']);
    await addLog(gabriel, 'informatica', '2026-05-18', 'presente', 'Atividade integrada: Internet, conflitos e Excel / planilha', 'Sem intercorrências', 'Prática no software realizada com sucesso', 'Professor');

    const agatha = await addStudent('Agatha Trindade Fernandes', 'Informática', '10/08/2026', '', ['informatica']);

    // 4. Português Reforço adicional
    const ozeias = await addStudent('Ozéias Borges Palhano', '5ª série - 10 anos', '28/04/2026', '', ['portugues_reforco']);
    await addLog(ozeias, 'portugues_reforco', '2026-05-05', 'presente', 'Interpretação de texto. Leitura e compreensão textual', 'Sem intercorrências', 'Boa leitura', 'Luciano');
    await addLog(ozeias, 'portugues_reforco', '2026-05-11', 'presente', 'Revisão para prova de geografia (cidade e área urbana)', 'Sem intercorrências', 'Revisão concluída', 'Luciano');
    await addLog(ozeias, 'portugues_reforco', '2026-08-27', 'presente', 'Leitura, escrita e palavras com S e SS', 'Sono e desatenção', 'Errou atividades por não ler enunciados com atenção', 'Fernanda');

    const anaClara = await addStudent('Ana Clara Sousa dos Santos', '1ª série - Alfabetização', '19/08/2026', '', ['portugues_reforco']);
    await addLog(anaClara, 'portugues_reforco', '2026-08-19', 'presente', 'Atividades lúdicas na lousa digital e impressas, consciência fonológica e cantiga Ciranda Cirandinha', 'Dificuldade de concentração / dispersão', 'Melhor desempenho em propostas lúdicas', 'Professora');
    await addLog(anaClara, 'portugues_reforco', '2026-09-03', 'presente', 'Jogo interativo de roleta fonológica e formação de palavras de 2 sílabas', 'Dificuldade de concentração', 'Praticou a escrita após a fonética', 'Professora');
    await addLog(anaClara, 'portugues_reforco', '2026-09-09', 'presente', 'Ortografia e todas as letras do alfabeto, fixação de vogais', 'Sem intercorrências', 'Teve melhor desenvolvimento nesta aula', 'Professora');
    await addLog(anaClara, 'portugues_reforco', '2026-09-16', 'presente', 'Alfabeto completo (vogais e consoantes) com jogo lúdico', 'Desvio constante de foco', 'Evoluindo bem, necessita reforço no foco', 'Professora');
    await addLog(anaClara, 'portugues_reforco', '2026-09-23', 'presente', 'Sílabas, sons da letra C vs S e jogo da memória fonético', 'Dificuldade de retenção na memória', 'Trabalhar mais a diferenciação do som de C e S', 'Professora');

    // 5. Redação
    await addStudent('Isabelle Franco', 'Redação', '11/02/2025', '25/05/2026', ['redacao']);
    await addStudent('Thaína Alves de Oliveira', 'Redação', '17/09/2025', '', ['redacao']);
    const geovana = await addStudent('Geovana Cristina Martins Costa', 'Redação', '17/07/2026', '', ['redacao']);
    await addLog(geovana, 'redacao', '2026-09-03', 'presente', 'Como começar uma redação dissertativa (introdução)', 'Sem intercorrências', 'Primeira estrutura desenvolvida', 'Professor');

    await addStudent('Gabriella Tatiana Figueiredo', 'Redação', '02/09/2026', '', ['redacao']);

    await client.query('COMMIT');
    console.log(' Povoamento inicial concluído com sucesso com todos os alunos e aulas da planilha!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(' Erro ao povoar o banco:', err);
  } finally {
    client.release();
  }
}

module.exports = { seedData };

if (require.main === module) {
  const { initDB } = require('./db');
  initDB().then(() => seedData()).then(() => process.exit(0));
}
