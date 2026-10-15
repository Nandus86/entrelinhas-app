# 📚 Portal Educacional Entrelinhas

Sistema web **mobile-first** da escola Entrelinhas: diário de classe, grade de horários, gestão de salas, Portal da Família, aulas online (EAD), tarefas e redações, financeiro e site institucional com captação de leads. Backend em **Node.js/Express**, banco **PostgreSQL**, frontend em JavaScript puro (`public/`).

---

## 🚀 Como acessar

O sistema roda em Docker (`docker compose up -d`):
👉 **`http://localhost:3030`**

---

## 🔐 Acesso inicial

| Perfil | Usuário | Senha |
| :--- | :--- | :--- |
| 👑 Administrador | `admin@entrelinhas.com` | `admin123` |

Em 07/10/2026 os dados de demonstração foram apagados para o início dos testes com dados reais. A equipe, as matérias, as salas, os alunos, os cursos e os planos são cadastrados pelo admin. O backup de antes da limpeza está em `backups/`.

--- | :--- | :--- | :--- |
| 👑 Administrador | `admin@entrelinhas.com` | `admin123` | Acesso total |
| 👨‍🏫 Prof. Luciano | `luciano@entrelinhas.com` | `prof123` | Português, Port. Concurso e Redação |
| 👩‍🏫 Profa. Sibele | `sibele@entrelinhas.com` | `prof123` | Matemática Reforço |
| 👨‍🏫 Prof. Fernando | `fernando@entrelinhas.com` | `prof123` | Informática e Matemática |
| 👨‍👩‍👧 Família | Código `PAIS-ANA`, `PAIS-DAVI`, `PAIS-NYCOLAS` | — | Só o próprio aluno |

---

## 🧭 Regras de negócio aplicadas pelo sistema

### Perfis e acesso
- **Professor** vê apenas os seus alunos: aqueles de quem é o responsável, com quem tem aula ativa na grade ou para quem já lançou aula. Isso vale para lista de alunos, relatórios, diário, agenda de recados e tarefas.
- **Família** vê apenas o próprio aluno (aulas, agenda, horários, faturas e tarefas). O login é feito somente pelo código de acesso cadastrado.
- **Admin** vê e gerencia tudo.

### Professor responsável e matrícula
- Cada aluno tem um professor **responsável**. Se o aluno tem aulas na grade, o responsável é sempre um dos professores dessas aulas (o sistema recalcula automaticamente ao mudar a grade).
- Aluno ativo sem professor fica com matrícula **"aguardando professor"** e aparece nas pendências do painel.
- Na edição do aluno: trocar o professor transfere os horários do antigo para o novo (validando conflitos); deixar o campo vazio desvincula e tira os horários dele da grade.
- Inativar um professor tira os horários dele da grade e recalcula os alunos afetados.

### Grade de horários
Todo horário (pela Grade, por "Amarrar Professor" ou no cadastro do aluno) passa pelas mesmas validações:
- horários no formato HH:MM e fim depois do início;
- o professor precisa estar ativo e lecionar a matéria;
- o professor não pode estar em duas salas ao mesmo tempo;
- o aluno não pode ter duas aulas no mesmo horário;
- limite de professores simultâneos da sala (`capacity_teachers`);
- capacidade de alunos da sala e limite da matéria (ex.: Informática = 2 alunos, por causa dos computadores).

**Frequências:** `semanal` (toda semana no dia escolhido), `quinzenal` (semana sim, semana não, a partir da 1ª ocorrência desde a data de início) e `custom_dias` (a cada N dias a partir da 1ª ocorrência). A mesma regra é usada na tela "Hoje" do professor e no calendário.

> Os conflitos de horário são verificados por dia da semana e faixa de horário, sem considerar a alternância das quinzenais — duas aulas quinzenais em semanas alternadas no mesmo horário são tratadas como conflito.

### Diário de classe
- Frequência: `presente` ou `falta`.
- Não aceita data futura nem dois lançamentos do mesmo aluno na mesma matéria no mesmo dia.
- O aluno precisa estar matriculado na matéria; o professor precisa lecioná-la e ter o aluno vinculado a ele.
- Professor edita/exclui apenas os próprios lançamentos.

### Exclusões
- **Aluno** com histórico (aulas, faturas ou tarefas) é **inativado**, não apagado. Sem histórico, é removido.
- **Professor** com aulas lançadas é inativado. **Matéria** com aulas lançadas ou na grade não pode ser excluída. **Sala** com aulas ativas na grade não pode ser excluída.

### Financeiro
- Valor maior que zero, desconto menor que o valor, número de fatura único (`FAT-AAAAMM-000123`).
- Só faturas **pendentes** podem ser pagas ou canceladas.
- Inadimplência = valor vencido e não pago ÷ total já vencido.
- ⚠️ O código Pix é **de demonstração** (chave fictícia); nenhum banco o aceita.

### Tarefas e redações
- Criadas por professor (para seus alunos) ou admin; enviadas pela família do próprio aluno; nota de 0 a 10; atividade corrigida não aceita novo envio.

---

## 🗄️ Banco de dados

Principais tabelas: `users`, `subjects`, `teacher_subjects`, `students`, `student_subjects`, `classrooms`, `teacher_schedules`, `class_logs`, `student_agenda`, `courses`, `course_modules`, `course_lessons`, `student_lesson_progress`, `student_assignments`, `financial_plans`, `invoices`, `leads_contacts` e `app_meta`.

**Povoamento de demonstração:** só roda numa instalação nova e uma única vez (controle na tabela `app_meta`). Reiniciar o servidor **não** altera dados já existentes.
