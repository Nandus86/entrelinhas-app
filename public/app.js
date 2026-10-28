/**
 * APLICATIVO MOBILE - DIÁRIO DE CLASSE ENTRELINHAS
 * Lógica da interface, autenticação individual de professores,
 * Painel Admin completo, Aba de Relatórios dia a dia por aluno e Gestão Pedagógica.
 */

const API_BASE = window.location.origin;

// Todas as chamadas à API do próprio sistema passam por aqui:
// 1. Envia o cabeçalho que impede o ngrok de responder com a página de aviso dele (HTML)
//    no lugar dos dados — era isso que quebrava o painel depois que o túnel reiniciava.
// 2. Se a sessão deixar de valer (401), limpa o login salvo e volta para a tela de login.
const nativeFetch = window.fetch.bind(window);
let sessionExpiredNotified = false;
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const isOwnApi = url.startsWith('/api/') || url.startsWith(`${API_BASE}/api/`);
  if (!isOwnApi) return nativeFetch(input, init);

  const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
  headers.set('ngrok-skip-browser-warning', 'true');
  const res = await nativeFetch(input, { ...init, headers });

  const isAuthRoute = url.includes('/api/auth/login') || url.includes('/api/auth/parent-login');
  if (res.status === 401 && !isAuthRoute && state.token) {
    clearSession();
    // Ao abrir o sistema com um login antigo, a volta silenciosa para o login basta (sem aviso)
    const isStartupCheck = url.includes('/api/auth/me');
    if (!sessionExpiredNotified && !isStartupCheck) {
      sessionExpiredNotified = true;
      showLogin(state.currentUser && state.currentUser.role === 'responsavel' ? 'parent' : 'school');
      showAppAlert('Sua sessão expirou ou não é mais válida. Entre novamente para continuar.', 'Sessão encerrada');
      setTimeout(() => { sessionExpiredNotified = false; }, 3000);
    }
  }
  return res;
};

function clearSession() {
  state.token = null;
  try { localStorage.removeItem('entrelinhas_auth'); } catch (e) {}
}

const state = {
  currentUser: null,
  token: null,
  activeView: 'view-students',
  selectedSubjectId: '',
  searchTerm: '',
  adminStudentSearch: '',
  adminSubjectSearch: '',
  adminClassroomSearch: '',
  classrooms: [],
  subjects: [],
  students: [],
  teachers: [],
  adminStudents: [],
  recentLogs: [],
  currentEntryStatus: 'presente',
  
  // Estado do Relatório
  selectedReportStudentId: null,
  reportFilterSubjectId: '',
  reportSortOrder: 'asc',
  currentReportData: null,

  // Estado da Grade de Horários (Google Calendar)
  calendarCurrentDate: new Date(),
  calendarView: 'month', // 'day', 'week', 'month', 'year'
  selectedScheduleDay: '',
  selectedScheduleTeacherId: '',
  selectedScheduleStudentId: '',
  selectedScheduleFrequency: '',
  schedules: [],
  pendingStudents: [],
  selectedEventForDetail: null,

  // Estado do Portal da Família (Pais) e Agenda
  parentStudent: null,
  parentAgenda: [],
  parentSchedules: [],
  parentClasses: [],
  parentActiveCategory: '',
  parentActiveDay: '',
  currentAgendaStudentId: null
};

// ==========================================
// HELPER: NORMALIZA RECURSOS DE SALA
// Recursos podem vir como string ou objeto {name, quantity, icon}
// ==========================================
function getResourceName(r) {
  if (!r) return '';
  if (typeof r === 'string') return r.trim();
  if (typeof r === 'object' && r.name) return String(r.name).trim();
  return String(r).trim();
}

// ==========================================
// HELPERS DE DATA E HORA (PADRÃO BRASIL / SÃO PAULO)
// FORMATO EXATO: DD/MM/YYYY - HHhMMm (Ex: 02/09/2026 - 07h30m)
// ==========================================
function getSaoPauloDateAndTimeString() {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  const map = {};
  parts.forEach(p => map[p.type] = p.value);
  return {
    dateIso: `${map.year}-${map.month}-${map.day}`,
    dateBr: `${map.day}/${map.month}/${map.year}`,
    timeStr: `${map.hour}:${map.minute}`,
    formatted: `${map.day}/${map.month}/${map.year} - ${map.hour}h${map.minute}m`
  };
}

function formatDateTimeBR(dateInput, timeInput) {
  if (!dateInput) return '';

  // Se já vier no formato exato "DD/MM/YYYY - HHhMMm", preserva
  if (typeof dateInput === 'string' && /^\d{2}\/\d{2}\/\d{4} - \d{2}h\d{2}m$/.test(dateInput.trim())) {
    return dateInput.trim();
  }

  let datePart = '';
  let timePart = '';

  if (typeof dateInput === 'string') {
    const clean = dateInput.trim();
    if (clean.includes('T')) {
      const [isoD, isoT] = clean.split('T');
      const dParts = isoD.split('-');
      if (dParts.length === 3) {
        datePart = `${dParts[2].padStart(2, '0')}/${dParts[1].padStart(2, '0')}/${dParts[0]}`;
      }
      if (!timeInput && isoT && !isoT.startsWith('00:00:00')) {
        const t = isoT.split('.')[0].split(':');
        if (t.length >= 2) timePart = `${t[0].padStart(2, '0')}h${t[1].padStart(2, '0')}m`;
      }
    } else if (clean.includes('-')) {
      const dParts = clean.split('-');
      if (dParts.length === 3) {
        datePart = `${dParts[2].padStart(2, '0')}/${dParts[1].padStart(2, '0')}/${dParts[0]}`;
      }
    } else if (clean.includes('/')) {
      datePart = clean;
    } else {
      datePart = clean;
    }
  } else if (dateInput instanceof Date) {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(dateInput);
    const m = {};
    parts.forEach(p => m[p.type] = p.value);
    datePart = `${m.day}/${m.month}/${m.year}`;
    if (!timeInput) timePart = `${m.hour}h${m.minute}m`;
  }

  if (!timePart) {
    if (timeInput) {
      const raw = String(timeInput).trim();
      if (/^\d{1,2}h\d{2}m$/i.test(raw)) {
        timePart = raw.toLowerCase().padStart(6, '0');
      } else if (raw.includes(':')) {
        const [h, m] = raw.split(':');
        timePart = `${h.padStart(2, '0')}h${(m || '00').substring(0, 2).padStart(2, '0')}m`;
      } else {
        timePart = '07h30m';
      }
    } else {
      timePart = '07h30m';
    }
  }

  return `${datePart} - ${timePart}`;
}

function formatDateBR(dateInput) {
  if (!dateInput) return '';
  if (typeof dateInput === 'string') {
    const clean = dateInput.trim();
    if (clean.includes('T')) {
      const [isoD] = clean.split('T');
      const parts = isoD.split('-');
      if (parts.length === 3) return `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
    }
    if (clean.includes('-')) {
      const parts = clean.split('-');
      if (parts.length === 3) return `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
    }
  }
  const dt = formatDateTimeBR(dateInput, '');
  return dt ? dt.split(' - ')[0] : '';
}

function formatLogDateTime(log) {
  if (!log) return '';
  if (log.formatted_date_time) {
    const val = String(log.formatted_date_time).trim();
    if (val.includes(' - ') && val.includes('h') && val.includes('m')) {
      return val;
    }
  }
  return formatDateTimeBR(log.class_date_br || log.class_date || log.created_at, log.class_time_display || log.class_time);
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupEventListeners();
  setupLeadsEvents();
  setupPortalManagementUI();
  setupFamilyMessaging();
  setupFamilyAlerts();
  checkAuthAndInit();

  // Atualiza métricas a cada 30 segundos
  setInterval(() => {
    if (state.token) {
      loadStats();
    }
  }, 30000);
});

// Helper de Headers com Bearer Token
function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  return headers;
}

// ==========================================
// CONTROLE DE AUTENTICAÇÃO
// ==========================================
async function checkAuthAndInit() {
  const savedAuth = localStorage.getItem('entrelinhas_auth');
  if (savedAuth) {
    try {
      const parsed = JSON.parse(savedAuth);
      state.token = parsed.token;
      state.currentUser = parsed.user;

      // Valida sessão com o backend
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: getAuthHeaders()
      });

      if (res.ok) {
        const data = await res.json();
        state.currentUser = data.user;
        showApp();
        return;
      }
    } catch (e) {
      console.warn('Sessão local inválida');
    }
  }

  // Se não estiver logado, exibe o Site Institucional do Portal Educacional
  showWebsite();
}

function showWebsite() {
  const webView = document.getElementById('view-website');
  const loginView = document.getElementById('view-login');
  const authApp = document.getElementById('authenticated-app');
  
  if (webView) webView.classList.remove('hidden');
  if (loginView) loginView.classList.add('hidden');
  if (authApp) authApp.classList.add('hidden');

  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadWebsiteCourses();
}

function showLogin(mode = 'school') {
  const webView = document.getElementById('view-website');
  const loginView = document.getElementById('view-login');
  const authApp = document.getElementById('authenticated-app');

  if (webView) webView.classList.add('hidden');
  if (loginView) loginView.classList.remove('hidden');
  if (authApp) authApp.classList.add('hidden');

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Sincroniza modo (equipe ou família)
  const tabSchool = document.getElementById('tab-login-school');
  const tabParent = document.getElementById('tab-login-parent');
  if (mode === 'parent' && tabParent) {
    tabParent.click();
  } else if (tabSchool) {
    tabSchool.click();
  }
}

function showApp() {
  const webView = document.getElementById('view-website');
  const loginView = document.getElementById('view-login');
  const authApp = document.getElementById('authenticated-app');

  if (webView) webView.classList.add('hidden');
  if (loginView) loginView.classList.add('hidden');
  if (authApp) authApp.classList.remove('hidden');

  updateUserInterfaceForRole();

  if (state.currentUser && state.currentUser.role === 'responsavel') {
    loadParentPortalData();
  } else {
    loadAllData();
  }
}

function updateUserInterfaceForRole() {
  const user = state.currentUser;
  if (!user) return;

  const badge = document.getElementById('current-user-badge');
  const icon = document.getElementById('current-user-icon');
  const nameEl = document.getElementById('current-user-name');
  const addScheduleBtn = document.getElementById('btn-add-schedule');
  const teacherReadonlyBadge = document.getElementById('badge-teacher-readonly');
  const subjectNavBar = document.getElementById('subject-nav-bar');

  // Define tema de papel no body
  document.body.classList.remove('app-role-admin', 'app-role-professor', 'app-role-responsavel');
  document.body.classList.add(`app-role-${user.role}`);

  // Controle de visibilidade das barras de navegação desktop e mobile
  const navAdminDesk = document.getElementById('desktop-nav-admin');
  const navTeacherDesk = document.getElementById('desktop-nav-teacher');
  const navParentDesk = document.getElementById('desktop-nav-parent');
  const navAdminBottom = document.getElementById('bottom-nav-admin');
  const navTeacherBottom = document.getElementById('bottom-nav-teacher');
  const navParentBottom = document.getElementById('bottom-nav-parent');

  [navAdminDesk, navTeacherDesk, navParentDesk, navAdminBottom, navTeacherBottom, navParentBottom].forEach(el => {
    if (el) el.classList.add('hidden');
  });

  // 1. Perfil Responsável / Portal da Família
  if (user.role === 'responsavel') {
    badge.classList.remove('admin-role');
    badge.classList.add('parent-role');
    icon.textContent = '👨‍👩‍👧';
    nameEl.textContent = user.name;

    if (navParentDesk) navParentDesk.classList.remove('hidden');
    if (navParentBottom) navParentBottom.classList.remove('hidden');
    if (subjectNavBar) subjectNavBar.classList.add('hidden');

    switchView('view-parent-portal');
    return;
  }

  // 2. Perfil Administrador (Coordenação Geral)
  if (user.role === 'admin') {
    badge.classList.add('admin-role');
    badge.classList.remove('parent-role');
    icon.textContent = '👑';
    nameEl.textContent = 'Admin (' + user.name.split(' ')[0] + ')';

    if (navAdminDesk) navAdminDesk.classList.remove('hidden');
    if (navAdminBottom) navAdminBottom.classList.remove('hidden');
    if (subjectNavBar) subjectNavBar.classList.remove('hidden');
    if (addScheduleBtn) addScheduleBtn.classList.remove('hidden');
    if (teacherReadonlyBadge) teacherReadonlyBadge.classList.add('hidden');

    const schedTeacherSelect = document.getElementById('select-filter-schedule-teacher');
    if (schedTeacherSelect && schedTeacherSelect.parentElement) {
      schedTeacherSelect.parentElement.classList.remove('hidden');
    }

    const histTitle = document.getElementById('history-view-title');
    const histSub = document.getElementById('history-view-subtitle');
    if (histTitle) histTitle.textContent = 'Feed Geral de Aulas';
    if (histSub) histSub.textContent = 'Histórico geral de todos os diários registrados na escola';

    switchView('view-admin-dashboard');
  } else {
    // 3. Perfil Professor (Docente)
    badge.classList.remove('admin-role');
    badge.classList.remove('parent-role');
    icon.textContent = '👨‍🏫';
    nameEl.textContent = 'Prof. ' + user.name.split(' ')[0];

    if (navTeacherDesk) navTeacherDesk.classList.remove('hidden');
    if (navTeacherBottom) navTeacherBottom.classList.remove('hidden');
    if (subjectNavBar) subjectNavBar.classList.remove('hidden');
    if (addScheduleBtn) addScheduleBtn.classList.add('hidden');
    if (teacherReadonlyBadge) teacherReadonlyBadge.classList.add('hidden'); // Ocultado para evitar sobrecarga negativa

    // Auto-trava a grade de horários no professor logado
    state.selectedScheduleTeacherId = String(user.id);
    const schedTeacherSelect = document.getElementById('select-filter-schedule-teacher');
    if (schedTeacherSelect && schedTeacherSelect.parentElement) {
      schedTeacherSelect.parentElement.classList.add('hidden');
    }

    const histTitle = document.getElementById('history-view-title');
    const histSub = document.getElementById('history-view-subtitle');
    if (histTitle) histTitle.textContent = '📖 Meu Diário de Aulas';
    if (histSub) histSub.textContent = 'Aulas ministradas e diários registrados por você';

    switchView('view-teacher-today');
  }

  // No formulário de lançamento, preenche e trava o professor logado
  const teacherInput = document.getElementById('entry-teacher');
  const teacherDisplay = document.getElementById('entry-teacher-display');
  if (teacherInput && teacherDisplay) {
    teacherInput.value = user.name;
    teacherDisplay.textContent = (user.role === 'admin' ? '👑 ' : '👨‍🏫 ') + user.name;
  }
}

async function handleLogin(email, password) {
  const errorEl = document.getElementById('login-error-msg');
  const btnSubmit = document.getElementById('btn-do-login');

  errorEl.classList.add('hidden');
  errorEl.textContent = '';
  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Entrando...';

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Falha ao autenticar.');
    }

    state.token = data.token;
    state.currentUser = data.user;
    localStorage.setItem('entrelinhas_auth', JSON.stringify({
      token: data.token,
      user: data.user
    }));

    showToast(`Bem-vindo(a), ${data.user.name}!`);
    showApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Entrar no Sistema';
  }
}

async function handleParentLogin(access_code, password = '') {
  const errorEl = document.getElementById('parent-login-error-msg');
  const btnSubmit = document.getElementById('btn-do-parent-login');

  if (errorEl) {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Conectando à Família...';
  }

  try {
    const payload = {};
    if (access_code) payload.access_code = access_code.trim();
    if (password) payload.password = password;

    const res = await fetch(`${API_BASE}/api/auth/parent-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Código de acesso da família não encontrado.');
    }

    state.token = data.token;
    state.currentUser = data.user;
    state.parentStudent = data.student;
    localStorage.setItem('entrelinhas_auth', JSON.stringify({
      token: data.token,
      user: data.user
    }));

    showToast(`Bem-vindo(a) ao Portal da Família!`);
    showApp();
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } else {
      showAppAlert(err.message, 'Erro de Acesso');
    }
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Acessar Portal da Família ➔';
    }
  }
}

function handleLogout() {
  showAppConfirm('Deseja realmente sair da sua conta?', () => {
    // Apaga a sessão salva: sem isso, recarregar a página entrava de novo na conta
    const wasParent = state.currentUser && state.currentUser.role === 'responsavel';
    clearSession();
    state.currentUser = null;
    showLogin(wasParent ? 'parent' : 'school');
    showToast('Você saiu do sistema.');
  }, 'Sair do Sistema');
}

// ==========================================
// CONTROLE DE NAVEGAÇÃO & ABAS MOBILE
// ==========================================
function setupNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetView = tab.getAttribute('data-view');
      if (targetView) switchView(targetView);
    });
  });

  // Sub-abas do Admin
  const subtabs = document.querySelectorAll('.admin-subtab');
  subtabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-subtab');

      if (targetId === 'admin-reports-shortcut') {
        switchView('view-reports');
        return;
      }

      subtabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(targetId).classList.remove('hidden');

      if (targetId === 'admin-teachers-tab') {
        loadTeachers();
      } else if (targetId === 'admin-students-tab') {
        loadAdminStudents();
      } else if (targetId === 'admin-subjects-tab') {
        loadAdminSubjects();
      } else if (targetId === 'admin-classrooms-tab') {
        loadClassrooms();
      }
    });
  });
}

function switchView(viewId) {
  state.activeView = viewId;
  
  // Atualiza painéis
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
  const activePanel = document.getElementById(viewId);
  if (activePanel) activePanel.classList.add('active');

  // Atualiza botões da barra inferior e superior (as abas do Portal da Família têm controle próprio)
  document.querySelectorAll('.nav-tab[data-view]').forEach(t => {
    if (t.getAttribute('data-view') === viewId) {
      t.classList.add('active');
    } else {
      t.classList.remove('active');
    }
  });

  // Filtro por matéria só faz sentido nas listas de alunos e de aulas
  const subjectBar = document.getElementById('subject-nav-bar');
  if (subjectBar) subjectBar.classList.toggle('is-off-context', !['view-students', 'view-history'].includes(viewId));

  // No celular, a barra inferior rola na horizontal: mantém a aba ativa à vista
  document.querySelectorAll('.bottom-nav:not(.hidden) .nav-tab.active').forEach(tab => {
    tab.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
  window.scrollTo({ top: 0 });

  // Carrega dados específicos da view
  if (viewId === 'view-admin-dashboard') loadAdminDashboard();
  if (viewId === 'view-teacher-today') loadTeacherTodayClasses();
  if (viewId === 'view-teacher-today') loadTeacherFamilyAlerts();
  if (viewId === 'view-students') loadStudents();
  if (viewId === 'view-history') loadGeneralHistory();
  if (viewId === 'view-stats') loadStats();
  if (viewId === 'view-admin') {
    loadTeachers();
    loadAdminStudents();
    loadAdminSubjects();
    loadClassrooms();
  }
  if (viewId === 'view-reports') {
    initReportsView();
  }
  if (viewId === 'view-schedules') {
    loadSchedules();
    loadPendingStudents();
  }
  if (viewId === 'view-admin-finance') {
    loadAdminFinancialDashboard();
  }
  if (viewId === 'view-admin-courses') {
    loadAdminCourses();
  }
  if (viewId === 'view-assignments') {
    loadAssignmentsView();
  }
  if (viewId === 'view-admin-leads') {
    loadAdminLeads();
  }
}

// ==========================================
// CARREGAMENTO DE DADOS
// ==========================================
async function loadAllData() {
  await Promise.all([
    loadClassrooms(),
    loadSubjects(),
    loadStudents(),
    loadStats(),
    loadSchedules()
  ]);
}

async function loadSubjects() {
  try {
    const res = await fetch(`${API_BASE}/api/subjects`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Erro ao buscar matérias');
    state.subjects = await res.json();
    renderSubjectPills();
  } catch (err) {
    console.error(err);
  }
}

async function loadStudents() {
  try {
    let url = `${API_BASE}/api/students?`;
    if (state.selectedSubjectId) url += `subject_id=${state.selectedSubjectId}&`;
    if (state.searchTerm) url += `search=${encodeURIComponent(state.searchTerm)}&`;

    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Erro ao carregar alunos');
    state.students = await res.json();
    renderStudentCards();
  } catch (err) {
    console.error(err);
    document.getElementById('students-list').innerHTML = `
      <div style="text-align: center; padding: 30px; color: var(--text-dim);">
        <p>Não foi possível carregar os alunos.</p>
        <button onclick="loadStudents()" class="btn-card-action primary" style="margin-top: 10px;">Tentar novamente</button>
      </div>
    `;
  }
}

async function loadGeneralHistory() {
  const container = document.getElementById('general-history-list');
  container.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-dim);">Carregando feed...</div>';
  try {
    let url = `${API_BASE}/api/logs?limit=40`;
    if (state.selectedSubjectId) url += `&subject_id=${state.selectedSubjectId}`;
    const res = await fetch(url, { headers: getAuthHeaders() });
    const logs = await res.json();
    
    if (logs.length === 0) {
      const isProf = state.currentUser && state.currentUser.role === 'professor';
      container.innerHTML = `<p style="text-align:center; padding: 20px; color: var(--text-dim);">${isProf ? 'Você ainda não registrou aulas com estes filtros.' : 'Nenhum lançamento no diário ainda.'}</p>`;
      return;
    }

    container.innerHTML = logs.map(log => createLogCardHTML(log)).join('');
  } catch (err) {
    container.innerHTML = '<p style="color: var(--danger); text-align:center;">Erro ao carregar histórico.</p>';
  }
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`, { headers: getAuthHeaders() });
    const stats = await res.json();
    
    document.getElementById('stat-total-students').textContent = stats.total_students || 0;
    document.getElementById('stat-total-teachers').textContent = stats.total_teachers || 0;
    document.getElementById('stat-total-logs').textContent = stats.total_logs || 0;
    document.getElementById('stat-total-presences').textContent = stats.total_presences || 0;
    document.getElementById('stat-total-absences').textContent = stats.total_absences || 0;

    // Renderização dos Aniversariantes do Mês
    const monthNames = [
      'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];
    const now = new Date();
    const currentMonthName = monthNames[now.getMonth()];
    const monthLabelEl = document.getElementById('birthdays-month-label');
    const countEl = document.getElementById('birthdays-count');
    const listEl = document.getElementById('birthdays-list');

    if (monthLabelEl) monthLabelEl.textContent = currentMonthName;
    if (listEl) {
      const bdays = Array.isArray(stats.birthdays) ? stats.birthdays : [];
      if (countEl) countEl.textContent = `${bdays.length} aniversariante(s)`;

      if (bdays.length === 0) {
        listEl.innerHTML = '<p class="text-xs text-muted" style="text-align:center; padding:14px 0;">Nenhum aluno aniversariante registrado neste mês.</p>';
      } else {
        const todayDay = now.getDate();
        listEl.innerHTML = bdays.map(b => {
          const isToday = parseInt(b.birth_day) === todayDay;
          return `
            <div class="birthday-item ${isToday ? 'birthday-today' : ''}">
              <div class="birthday-badge">
                <span class="birthday-day">${String(b.birth_day).padStart(2, '0')}</span>
                <span class="birthday-month-sub">${currentMonthName.substring(0, 3).toLowerCase()}</span>
              </div>
              <div class="birthday-info">
                <strong>${escapeHtmlDoc(b.name)}</strong>
                <span class="text-xs ${isToday ? 'birthday-highlight' : 'text-muted'}">
                  ${isToday ? '🎉 <strong>Hoje é o aniversário!</strong>' : `Aniversário dia ${b.birth_day}`}
                  ${b.school_name ? ' • 🏫 ' + escapeHtmlDoc(b.school_name) : ''}
                </span>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error(err);
  }
}

// ==========================================
// RENDERIZADORES DO APLICATIVO
// ==========================================
function renderSubjectPills() {
  const container = document.getElementById('subject-pills');
  const isProf = state.currentUser && state.currentUser.role === 'professor';
  const profSubjectIds = isProf && state.currentUser.subjects ? state.currentUser.subjects.map(s => s.id) : null;

  let html = `<button class="pill ${state.selectedSubjectId === '' ? 'active' : ''}" data-subject-id="">${isProf ? 'Minhas Turmas' : 'Todas as Turmas'}</button>`;
  
  state.subjects.forEach(sub => {
    if (profSubjectIds && profSubjectIds.length > 0 && !profSubjectIds.includes(sub.id)) {
      return;
    }

    const isActive = state.selectedSubjectId === String(sub.id) ? 'active' : '';
    html += `
      <button class="pill ${isActive}" data-subject-id="${sub.id}">
        ${sub.name} (${sub.student_count})
      </button>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll('.pill').forEach(pill => {
    pill.addEventListener('click', () => {
      container.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.selectedSubjectId = pill.getAttribute('data-subject-id');
      loadStudents();
      if (state.activeView === 'view-history') {
        loadGeneralHistory();
      }
    });
  });
}

function renderStudentCards() {
  const container = document.getElementById('students-list');
  const counter = document.getElementById('students-counter');

  counter.textContent = `${state.students.length} aluno(s) disponível(is)`;

  if (state.students.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--text-dim);">
        <p style="font-size: 1.1rem; margin-bottom: 8px;">Nenhum aluno encontrado</p>
        <span style="font-size: 0.8rem;">Verifique o filtro de matérias ou cadastre um aluno no Painel Admin.</span>
      </div>
    `;
    return;
  }

  const isProf = state.currentUser && state.currentUser.role === 'professor';

  container.innerHTML = state.students.map(st => {
    const hasAbsences = parseInt(st.total_absences || 0) > 0;
    const subjectsTags = (st.subjects || []).map(s => `<span class="subject-tag">${s.name}</span>`).join('');
    
    let lastDateText = 'Sem registros';
    if (st.last_class_formatted) {
      lastDateText = `Última aula: ${st.last_class_formatted}`;
    } else if (st.last_class_date || st.last_class_date_br) {
      const dt = formatDateTimeBR(st.last_class_date || st.last_class_date_br, st.last_class_time);
      lastDateText = `Última aula: ${dt}`;
    }

    if (isProf) {
      // Card do Aluno para o Professor: Limpo, sem código sigiloso dos pais, ação primária clara
      return `
        <div class="student-card student-card-teacher" data-student-id="${st.id}">
          <div class="card-top">
            <div>
              <div class="student-name">${st.name}</div>
              <div class="student-grade">${st.objective_grade || 'Diário de Classe'}</div>
            </div>
            <div class="presence-badge ${hasAbsences ? 'has-absences' : ''}">
              <span>${st.total_presences || 0} Presenças</span>
              ${hasAbsences ? `<span>• ${st.total_absences} Faltas</span>` : ''}
            </div>
          </div>

          <div class="tags-row">
            ${subjectsTags}
          </div>

          <div class="card-bottom">
            <span class="last-class-info">${lastDateText}</span>
            <div class="card-actions" style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="btn-card-action secondary btn-open-agenda" data-student-id="${st.id}" title="Enviar Recado aos Pais">
                💬 Recado
              </button>
              <button class="btn-card-action secondary btn-open-history" data-student-id="${st.id}" title="Ver Histórico">
                📖 Histórico
              </button>
              <button class="btn-card-action secondary" onclick="event.stopPropagation(); openPedagogicalReports(${st.id})" title="Relatório de Acompanhamento Pedagógico">
                📋 Ficha
              </button>
              <button class="btn-card-action primary btn-quick-entry" data-student-id="${st.id}">
                ✏️ Lançar Aula
              </button>
            </div>
          </div>
        </div>
      `;
    }

    // Card do Aluno para o Administrador: Visão Completa
    return `
      <div class="student-card" data-student-id="${st.id}">
        <div class="card-top">
          <div>
            <div class="student-name">
              ${st.name}
              ${st.parent_access_code ? `
                <span class="hero-code-badge" style="font-size:0.72rem; padding:1px 6px; margin-left:6px;" title="Código de Acesso dos Pais">
                  🔑 ${st.parent_access_code}
                </span>
              ` : ''}
            </div>
            <div class="student-grade">${st.objective_grade || 'Diário de Classe'}</div>
          </div>
          <div class="presence-badge ${hasAbsences ? 'has-absences' : ''}">
            <span>${st.total_presences || 0} Presenças</span>
            ${hasAbsences ? `<span>• ${st.total_absences} Faltas</span>` : ''}
          </div>
        </div>

        <div class="tags-row">
          ${subjectsTags}
        </div>

        <div class="card-bottom">
          <span class="last-class-info">${lastDateText}</span>
          <div class="card-actions">
            <button class="btn-card-action secondary btn-open-agenda" data-student-id="${st.id}" title="Agenda e Recados para a Família">
              📅 Agenda
            </button>
            <button class="btn-card-action secondary btn-preview-parent" data-student-id="${st.id}" title="Ver exatamente como a família visualiza o portal">
              👁️ Portal Pais
            </button>
            <button class="btn-card-action secondary btn-open-history" data-student-id="${st.id}" title="Linha do tempo">
              📖 Histórico
            </button>
            <button class="btn-card-action secondary btn-open-report" data-student-id="${st.id}" title="Relatório completo dia a dia">
              📑 Relatório
            </button>
            <button class="btn-card-action secondary" onclick="event.stopPropagation(); openPedagogicalReports(${st.id})" title="Relatório de Acompanhamento Pedagógico">
              📋 Ficha
            </button>
            <button class="btn-card-action primary btn-quick-entry" data-student-id="${st.id}">
              ✏️ Lançar Aula
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-quick-entry').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openClassEntryModal(btn.getAttribute('data-student-id'));
    });
  });

  container.querySelectorAll('.btn-open-agenda').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openStudentAgendaModal(btn.getAttribute('data-student-id'));
    });
  });

  container.querySelectorAll('.btn-preview-parent').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      previewParentPortal(btn.getAttribute('data-student-id'));
    });
  });

  container.querySelectorAll('.btn-open-history').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openStudentHistoryModal(btn.getAttribute('data-student-id'));
    });
  });

  container.querySelectorAll('.btn-open-report').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openStudentReportDirectly(btn.getAttribute('data-student-id'));
    });
  });

  container.querySelectorAll('.student-card').forEach(card => {
    card.addEventListener('click', () => {
      openClassEntryModal(card.getAttribute('data-student-id'));
    });
  });
}

function createLogCardHTML(log) {
  const isFalta = log.status === 'falta';
  const dateTimeFormatted = formatLogDateTime(log);
  const u = state.currentUser;
  const canManage = u && (u.role === 'admin' || (log.teacher_id && u.id === log.teacher_id) || (log.teacher_name && u.name === log.teacher_name) || (log.teacher_display_name && u.name === log.teacher_display_name));

  return `
    <div class="log-card" data-log-id="${log.id}">
      <div class="log-header">
        <div>
          <span class="log-title">${log.student_name}</span>
          <span class="subject-tag" style="margin-left: 6px;">${log.subject_name}</span>
        </div>
        <span class="log-status-chip ${log.status}">${log.status}</span>
      </div>

      <div style="margin-bottom: 6px;">
        <span class="log-date">📅 ${dateTimeFormatted}</span>
      </div>

      ${!isFalta ? `<p class="log-content-text">${log.content || 'Sem descrição'}</p>` : '<p class="log-content-text" style="color: var(--danger);">Aluno ausente nesta data.</p>'}

      ${log.incidents && log.incidents !== 'Sem intercorrências' ? `
        <div class="log-details-block">
          <strong>Intercorrência:</strong> <em>${log.incidents}</em>
        </div>
      ` : ''}

      ${log.pedagogical_notes ? `
        <div class="log-details-block" style="margin-top: 4px;">
          <strong>Obs. Pedagógica:</strong> ${log.pedagogical_notes}
        </div>
      ` : ''}

      ${(log.classroom_name || (Array.isArray(log.resources_used) && log.resources_used.length > 0)) ? `
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; align-items:center;">
          ${log.classroom_name ? `<span class="classroom-pill type-presencial" style="font-size:0.72rem;">🏛️ ${log.classroom_name}</span>` : ''}
          ${(Array.isArray(log.resources_used) ? log.resources_used : []).map(r => `<span class="used-resource-badge">📦 ${r}</span>`).join('')}
        </div>
      ` : ''}

      <div class="log-footer">
        <span>👨‍🏫 Prof. ${log.teacher_display_name || log.teacher_name || 'Luciano'}</span>
        ${canManage ? `
          <div class="log-actions">
            <button class="log-action-btn" onclick="editLogEntry('${log.id}')" title="Editar este diário">✏️ Editar</button>
            <button class="log-action-btn danger" onclick="deleteLogEntry('${log.id}')" title="Excluir este diário">🗑️ Excluir</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ==========================================
// ABA DE RELATÓRIOS DO ALUNO (DIA A DIA)
// ==========================================
async function initReportsView() {
  const emissionEl = document.getElementById('report-emission-date');
  if (emissionEl) {
    const sp = getSaoPauloDateAndTimeString();
    emissionEl.textContent = `Emissão (Brasília): ${sp.formatted}`;
  }

  // Preenche dropdown de alunos
  await populateReportStudentsDropdown();
  await renderReportQuickGrid();

  // Se já houver um aluno selecionado no estado, carrega o relatório dele
  if (state.selectedReportStudentId) {
    loadStudentReport(state.selectedReportStudentId);
  }
}

async function populateReportStudentsDropdown() {
  const select = document.getElementById('report-student-select');
  if (!select) return;

  try {
    let studentsToUse = state.students;
    if (!studentsToUse || studentsToUse.length === 0) {
      const res = await fetch(`${API_BASE}/api/students`, { headers: getAuthHeaders() });
      studentsToUse = await res.json();
    }

    let html = '<option value="">Selecione um aluno para gerar o relatório...</option>';
    studentsToUse.forEach(s => {
      const isSelected = String(s.id) === String(state.selectedReportStudentId) ? 'selected' : '';
      html += `<option value="${s.id}" ${isSelected}>${s.name} (${s.objective_grade || 'Aluno'})</option>`;
    });

    select.innerHTML = html;
  } catch (err) {
    console.error('Erro ao popular select de relatório:', err);
  }
}

async function renderReportQuickGrid() {
  const grid = document.getElementById('report-quick-students-list');
  if (!grid) return;

  try {
    const res = await fetch(`${API_BASE}/api/reports/overview`, { headers: getAuthHeaders() });
    const overview = await res.json();

    if (overview.length === 0) {
      grid.innerHTML = '<p class="text-xs text-muted">Nenhum aluno disponível.</p>';
      return;
    }

    grid.innerHTML = overview.slice(0, 8).map(st => `
      <button class="report-quick-item" data-id="${st.id}">
        <span class="report-quick-name">${st.name}</span>
        <div class="report-quick-meta">
          <span>${st.total_classes} aulas</span>
          <span style="color: ${st.attendance_rate >= 75 ? 'var(--success)' : 'var(--warning)'}; font-weight:700;">
            ${st.attendance_rate}% freq.
          </span>
        </div>
      </button>
    `).join('');

    grid.querySelectorAll('.report-quick-item').forEach(b => {
      b.addEventListener('click', () => {
        const studentId = b.getAttribute('data-id');
        loadStudentReport(studentId);
      });
    });
  } catch (err) {
    grid.innerHTML = '<p class="text-xs text-muted">Falha ao carregar lista rápida.</p>';
  }
}

function openStudentReportDirectly(studentId) {
  state.selectedReportStudentId = studentId;
  switchView('view-reports');
  loadStudentReport(studentId);
}

async function loadStudentReport(studentId) {
  if (!studentId) return;
  state.selectedReportStudentId = studentId;

  // Atualiza select
  const select = document.getElementById('report-student-select');
  if (select) select.value = studentId;

  const placeholder = document.getElementById('report-empty-placeholder');
  const sheet = document.getElementById('report-student-sheet');
  const filtersRow = document.getElementById('report-secondary-filters');
  const actionsStrip = document.getElementById('report-actions-strip');
  const logsContainer = document.getElementById('rep-daily-logs-list');

  logsContainer.innerHTML = '<div style="text-align:center; padding: 25px;">Carregando histórico dia a dia...</div>';
  placeholder.classList.add('hidden');
  sheet.classList.remove('hidden');
  filtersRow.style.display = 'flex';
  actionsStrip.style.display = 'flex';

  try {
    let url = `${API_BASE}/api/reports/student/${studentId}?`;
    if (state.reportFilterSubjectId) url += `subject_id=${state.reportFilterSubjectId}&`;
    if (state.reportSortOrder) url += `order=${state.reportSortOrder}&`;

    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Falha ao carregar relatório');
    const data = await res.json();
    state.currentReportData = data;

    renderStudentReportData(data);
    renderReportPedSection(studentId);
  } catch (err) {
    logsContainer.innerHTML = `<p style="color:var(--danger); text-align:center; padding:20px;">${err.message}</p>`;
  }
}

function renderStudentReportData(data) {
  const { student, stats, logs } = data;

  // 1. Dados do Cabeçalho do Aluno
  document.getElementById('rep-student-name').textContent = student.name;
  document.getElementById('rep-student-grade').textContent = student.objective_grade || 'Objetivo Pedagógico Geral';
  document.getElementById('rep-student-start').textContent = `Início: ${student.start_date || 'Não informado'}`;
  
  const emissionEl = document.getElementById('report-emission-date');
  if (emissionEl) {
    emissionEl.textContent = `Emissão (Brasília): ${data.emission_date_time || getSaoPauloDateAndTimeString().formatted}`;
  }
  
  const statusBadge = document.getElementById('rep-student-status');
  statusBadge.textContent = (student.status || 'ativo').toUpperCase();
  statusBadge.className = `status-badge ${student.status || 'ativo'}`;

  // Badges de matérias
  const subjectsContainer = document.getElementById('rep-student-subjects');
  subjectsContainer.innerHTML = (student.subjects || []).map(s => `
    <span class="subject-tag">${s.name}</span>
  `).join('') || '<span class="text-xs text-muted">Sem turmas registradas</span>';

  // 2. Indicadores Numéricos
  document.getElementById('rep-kpi-total').textContent = stats.total_classes;
  document.getElementById('rep-kpi-presences').textContent = stats.total_presences;
  document.getElementById('rep-kpi-absences').textContent = stats.total_absences;
  document.getElementById('rep-kpi-rate').textContent = stats.total_classes > 0 ? `${stats.attendance_rate}%` : '—';

  // 3. Resumo por Matéria
  const breakdownContainer = document.getElementById('rep-subjects-summary');
  const subjectsEntries = Object.entries(stats.subjects_breakdown || {});
  if (subjectsEntries.length > 0) {
    breakdownContainer.innerHTML = `
      <h5>Resumo por Matéria / Turma</h5>
      ${subjectsEntries.map(([subName, s]) => `
        <div class="subject-stat-row">
          <span><strong>${subName}</strong> (${s.total} aulas)</span>
          <span>✅ ${s.presences} presenças • ❌ ${s.absences} faltas</span>
        </div>
      `).join('')}
    `;
    breakdownContainer.style.display = 'flex';
  } else {
    breakdownContainer.style.display = 'none';
  }

  // 4. Popula filtro de matérias se ainda não estiver populado para este aluno
  const subjectFilterSelect = document.getElementById('report-filter-subject');
  if (subjectFilterSelect) {
    let subOptions = '<option value="">Todas as Matérias</option>';
    (student.subjects || []).forEach(s => {
      const isSel = String(s.id) === String(state.reportFilterSubjectId) ? 'selected' : '';
      subOptions += `<option value="${s.id}" ${isSel}>${s.name}</option>`;
    });
    subjectFilterSelect.innerHTML = subOptions;
  }

  // 5. Diário Dia a Dia (Lista de Aulas Detalhadas)
  const logsContainer = document.getElementById('rep-daily-logs-list');
  const counterEl = document.getElementById('rep-logs-counter');
  counterEl.textContent = `${logs.length} aula(s) registrada(s)`;

  if (logs.length === 0) {
    logsContainer.innerHTML = `
      <div style="text-align:center; padding: 35px 20px; color: var(--text-dim); background: var(--bg-card); border-radius: var(--radius-md);">
        <p style="font-size: 1rem; margin-bottom: 4px;">Nenhuma aula encontrada para os filtros selecionados.</p>
        <span class="text-xs">Altere a matéria ou selecione "Todas as Matérias" para visualizar.</span>
      </div>
    `;
    return;
  }

  logsContainer.innerHTML = logs.map((log, index) => {
    const isFalta = log.status === 'falta';
    const dateTimeFormatted = formatLogDateTime(log);

    return `
      <div class="daily-log-card status-${log.status}">
        <div class="daily-header">
          <div class="daily-date-box">
            <span style="font-size: 1.1rem;">📅</span>
            <div>
              <span class="daily-date-badge">${dateTimeFormatted}</span>
              <span class="subject-tag" style="margin-left: 6px;">${log.subject_name}</span>
            </div>
          </div>
          <span class="log-status-chip ${log.status}">
            ${log.status === 'presente' ? '✅ Presente' : '❌ Falta'}
          </span>
        </div>

        <div class="daily-body-content">
          <div>
            <div class="daily-field-title">📘 Conteúdo Realizado no Dia:</div>
            ${!isFalta ? `
              <div class="daily-content-text">${log.content || 'Sem descrição específica.'}</div>
            ` : `
              <div class="daily-content-text" style="color: var(--danger); border-left-color: var(--danger);">
                Aluno faltou na aula agendada para este dia.
              </div>
            `}
          </div>

          ${log.incidents && log.incidents !== 'Sem intercorrências' ? `
            <div>
              <div class="daily-field-title">⚠️ Intercorrências Registradas:</div>
              <div class="daily-incident-box">${log.incidents}</div>
            </div>
          ` : `
            <div>
              <span class="text-xs text-muted">✓ Sem intercorrências registradas.</span>
            </div>
          `}

          ${log.pedagogical_notes ? `
            <div>
              <div class="daily-field-title">💡 Observações Pedagógicas & Evolução:</div>
              <div class="daily-pedagogical-box">"${log.pedagogical_notes}"</div>
            </div>
          ` : ''}
        </div>

        <div class="daily-footer-meta">
          <span>👨‍🏫 Ministrada por: <strong>Prof. ${log.teacher_display_name || log.teacher_name}</strong></span>
          <span style="color: var(--text-dim); font-size: 0.72rem;">Aula #${index + 1}</span>
        </div>
      </div>
    `;
  }).join('');
}

function printReport() {
  if (!state.currentReportData) {
    showAppAlert('Selecione um aluno primeiro para gerar o relatório pedagógico.', 'Relatórios');
    return;
  }
  window.print();
}

function exportReportCSV() {
  if (!state.currentReportData) {
    showAppAlert('Selecione um aluno primeiro para exportar a planilha.', 'Exportação CSV');
    return;
  }

  const { student, logs } = state.currentReportData;
  const header = ['Data', 'Matéria', 'Professor', 'Frequência', 'Conteúdo da Aula', 'Intercorrências', 'Observações Pedagógicas'];
  
  const rows = logs.map(l => {
    const dateFormatted = l.formatted_date_time || formatDateTimeBR(l.class_date_br || l.class_date, l.class_time_display || l.class_time);
    return [
      `"${dateFormatted}"`,
      `"${(l.subject_name || '').replace(/"/g, '""')}"`,
      `"${(l.teacher_display_name || l.teacher_name || '').replace(/"/g, '""')}"`,
      `"${l.status.toUpperCase()}"`,
      `"${(l.content || '').replace(/"/g, '""')}"`,
      `"${(l.incidents || '').replace(/"/g, '""')}"`,
      `"${(l.pedagogical_notes || '').replace(/"/g, '""')}"`
    ].join(';');
  });

  const csvContent = '\uFEFF' + [header.join(';'), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  const cleanName = student.name.replace(/[^a-zA-Z0-9]/g, '_');
  a.download = `Relatorio_${cleanName}_Entrelinhas.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Planilha CSV gerada com sucesso!');
}

// ==========================================
// PAINEL ADMIN: GESTÃO DE PROFESSORES
// ==========================================
async function loadTeachers() {
  const container = document.getElementById('teachers-cards-list');
  const counter = document.getElementById('teachers-counter');
  if (container) container.innerHTML = '<div style="text-align:center; padding: 20px;">Carregando professores...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/teachers`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Falha ao buscar professores');
    state.teachers = await res.json();

    if (counter) counter.textContent = `${state.teachers.length} usuário(s) cadastrado(s)`;

    if (container) {
      if (state.teachers.length === 0) {
        container.innerHTML = '<p class="text-muted" style="text-align:center; padding:20px;">Nenhum professor cadastrado.</p>';
        return;
      }

    container.innerHTML = state.teachers.map(t => {
      const isSelf = state.currentUser && state.currentUser.id === t.id;
      const initial = t.name.charAt(0).toUpperCase();
      const subjectsBadges = (t.subjects || []).map(s => `<span class="subject-tag">${s.name}</span>`).join('') || '<span class="text-xs text-muted">Nenhuma matéria vinculada</span>';

      const lastClassText = t.last_class_date 
        ? `Última aula: ${formatDateBR(t.last_class_date)}`
        : 'Sem lançamentos recentes';
      const studentsCount = t.total_students_linked || 0;

      return `
        <div class="teacher-card">
          <div class="teacher-card-header">
            <div class="teacher-title-box">
              <div class="teacher-avatar-circle">${initial}</div>
              <div class="teacher-name-box">
                <h4>${t.name} ${isSelf ? '<small style="color:var(--primary-light);">(Você)</small>' : ''}</h4>
                <span>${t.email}</span>
              </div>
            </div>
            <div style="display:flex; gap:4px; align-items:center;">
              <span class="role-badge ${t.role}">${t.role}</span>
              <span class="status-badge ${t.status}">${t.status}</span>
            </div>
          </div>

          <div class="teacher-subjects-tags">
            ${subjectsBadges}
          </div>

          <div class="teacher-card-actions">
            <div style="display:flex; flex-direction:column; gap:2px;">
              <span class="teacher-meta-count">📝 ${t.total_classes_logged || 0} aulas registradas • 👥 ${studentsCount} aluno(s)</span>
              <small style="color:var(--text-dim); font-size:0.75rem;">⏱️ ${lastClassText}</small>
            </div>
            <div class="btn-card-group">
              <button class="btn-action-sm btn-edit-teacher" data-id="${t.id}">✏️ Editar</button>
              ${!isSelf ? `
                <button class="btn-action-sm danger btn-delete-teacher" data-id="${t.id}">
                  ${t.status === 'ativo' ? '🚫 Inativar' : '🗑️ Remover'}
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-edit-teacher').forEach(b => {
      b.addEventListener('click', () => openTeacherModal(b.getAttribute('data-id')));
    });

    container.querySelectorAll('.btn-delete-teacher').forEach(b => {
      b.addEventListener('click', () => handleDeleteTeacher(b.getAttribute('data-id')));
    });
    }
  } catch (err) {
    if (container) container.innerHTML = `<p style="color:var(--danger); text-align:center;">${err.message}</p>`;
  }
}


// Professores que podem receber alunos e horários: perfil professor e ativos (o admin não dá aula)
function assignableTeacherOptions(selectedId = null) {
  const list = (state.teachers || []).filter(t => t.role === 'professor' && t.status === 'ativo');
  if (list.length === 0) return '<option value="" disabled>Nenhum professor ativo — cadastre em Gestão > Professores</option>';
  return list.map(t => {
    const subs = (t.subjects || []).map(s => s.name).join(', ');
    return `<option value="${t.id}" ${String(selectedId) === String(t.id) ? 'selected' : ''}>👨‍🏫 ${escapeHtml(t.name)}${subs ? ' — ' + escapeHtml(subs) : ''}</option>`;
  }).join('');
}

function openTeacherModal(teacherId = null) {
  const modal = document.getElementById('modal-teacher-admin');
  const title = document.getElementById('teacher-modal-title');
  const form = document.getElementById('form-teacher-admin');
  form.reset();

  const cbContainer = document.getElementById('teacher-subjects-checkboxes');
  cbContainer.innerHTML = state.subjects.map(s => `
    <label style="display:flex; align-items:center; gap:8px; font-size:0.85rem; margin-bottom:6px;">
      <input type="checkbox" name="teacher_sub" value="${s.id}">
      <span>${s.name}</span>
    </label>
  `).join('');

  if (teacherId) {
    const teacher = state.teachers.find(t => String(t.id) === String(teacherId));
    if (!teacher) return;

    title.textContent = 'Editar Professor';
    document.getElementById('teacher-edit-id').value = teacher.id;
    document.getElementById('teacher-name').value = teacher.name;
    document.getElementById('teacher-email').value = teacher.email;
    document.getElementById('teacher-role').value = teacher.role;
    document.getElementById('teacher-status').value = teacher.status;
    document.getElementById('teacher-phone').value = teacher.phone || '';
    document.getElementById('teacher-password').placeholder = 'Deixe em branco para não alterar';
    document.getElementById('hint-teacher-password').textContent = 'Preencha apenas se desejar redefinir a senha do professor.';

    const subIds = (teacher.subjects || []).map(s => s.id);
    document.querySelectorAll('input[name="teacher_sub"]').forEach(cb => {
      if (subIds.includes(parseInt(cb.value))) cb.checked = true;
    });
  } else {
    title.textContent = 'Cadastrar Novo Professor';
    document.getElementById('teacher-edit-id').value = '';
    document.getElementById('teacher-password').placeholder = 'Mínimo 6 caracteres';
    document.getElementById('hint-teacher-password').textContent = 'Senha obrigatória para novo professor.';
  }

  // Documentos: disponíveis só depois que o professor existe
  const docsGroup = document.getElementById('group-teacher-documents');
  docsGroup.classList.toggle('hidden', !teacherId);
  document.getElementById('teacher-documents-list').innerHTML = '';
  if (teacherId) loadTeacherDocuments(teacherId);

  modal.classList.remove('hidden');
}

const TEACHER_DOC_LABELS = {
  curriculo: '📄 Currículo',
  documento_pessoal: '🪪 Documento pessoal',
  contrato: '📝 Contrato',
  certificado: '🎓 Certificado',
  outro: '📎 Outro'
};

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtmlDoc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadTeacherDocuments(teacherId) {
  const list = document.getElementById('teacher-documents-list');
  list.innerHTML = '<p class="text-xs text-muted">Carregando documentos...</p>';
  try {
    const res = await fetch(`${API_BASE}/api/teachers/${teacherId}/documents`, { headers: getAuthHeaders() });
    const docs = await res.json();
    if (!res.ok) throw new Error(docs.error || 'Erro ao carregar documentos');
    if (docs.length === 0) {
      list.innerHTML = '<p class="text-xs text-muted">Nenhum documento anexado.</p>';
      return;
    }
    list.innerHTML = docs.map(d => `
      <div class="teacher-doc-item">
        <div class="teacher-doc-info">
          <strong>${escapeHtmlDoc(d.file_name)}</strong>
          <span class="text-xs text-muted">${TEACHER_DOC_LABELS[d.category] || d.category}${d.description ? ' • ' + escapeHtmlDoc(d.description) : ''} • ${formatFileSize(d.size_bytes)} • ${new Date(d.created_at).toLocaleDateString('pt-BR')}</span>
        </div>
        <div class="teacher-doc-actions">
          <button type="button" class="btn-action-pill btn-doc-download" data-id="${d.id}" data-name="${escapeHtmlDoc(d.file_name)}" title="Baixar">⬇️</button>
          <button type="button" class="btn-action-pill danger btn-doc-delete" data-id="${d.id}" title="Excluir">🗑️</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.btn-doc-download').forEach(b => b.addEventListener('click', () => downloadTeacherDocument(b.dataset.id, b.dataset.name)));
    list.querySelectorAll('.btn-doc-delete').forEach(b => b.addEventListener('click', () => {
      showAppConfirm('Excluir este documento? Esta ação não pode ser desfeita.', async () => {
        try {
          const r = await fetch(`${API_BASE}/api/teacher-documents/${b.dataset.id}`, { method: 'DELETE', headers: getAuthHeaders() });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Erro ao excluir');
          showToast('Documento removido.');
          loadTeacherDocuments(teacherId);
          loadTeachers();
        } catch (err) {
          showAppAlert(err.message, 'Documentos');
        }
      }, 'Excluir Documento', true);
    }));
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger);" class="text-xs">${escapeHtmlDoc(err.message)}</p>`;
  }
}

async function downloadTeacherDocument(docId, fileName) {
  try {
    const res = await fetch(`${API_BASE}/api/teacher-documents/${docId}/download`, { headers: getAuthHeaders() });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || 'Erro ao baixar documento');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'documento';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    showAppAlert(err.message, 'Documentos');
  }
}

async function uploadTeacherDocument() {
  const teacherId = document.getElementById('teacher-edit-id').value;
  const fileInput = document.getElementById('teacher-doc-file');
  const file = fileInput.files && fileInput.files[0];
  if (!teacherId) return;
  if (!file) return showAppAlert('Escolha um arquivo para anexar.', 'Documentos');
  if (file.size > 10 * 1024 * 1024) return showAppAlert('O arquivo passa do limite de 10 MB.', 'Documentos');

  const btn = document.getElementById('btn-upload-teacher-doc');
  btn.disabled = true;
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
      reader.readAsDataURL(file);
    });
    const res = await fetch(`${API_BASE}/api/teachers/${teacherId}/documents`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        file_name: file.name,
        mime_type: file.type,
        data_base64: dataUrl,
        category: document.getElementById('teacher-doc-category').value,
        description: document.getElementById('teacher-doc-description').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao anexar documento');
    showToast('Documento anexado!');
    fileInput.value = '';
    document.getElementById('teacher-doc-description').value = '';
    loadTeacherDocuments(teacherId);
    loadTeachers();
  } catch (err) {
    showAppAlert(err.message, 'Documentos');
  } finally {
    btn.disabled = false;
  }
}

async function handleDeleteTeacher(teacherId) {
  showAppConfirm('Deseja realmente inativar ou remover este professor do sistema?', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/teachers/${teacherId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao excluir professor');
      showToast(data.message || 'Professor removido.');
      loadTeachers();
      loadStats();
    } catch (err) {
      showAppAlert(err.message, 'Erro ao Excluir');
    }
  }, 'Inativar/Remover Professor', true);
}

// ==========================================
// PAINEL ADMIN: GESTÃO DE ALUNOS
// ==========================================
async function loadAdminStudents() {
  const container = document.getElementById('admin-students-cards-list');
  const counter = document.getElementById('admin-students-counter');
  container.innerHTML = '<div style="text-align:center; padding: 20px;">Carregando alunos...</div>';

  try {
    let url = `${API_BASE}/api/students`;
    if (state.adminStudentSearch) {
      url += `?search=${encodeURIComponent(state.adminStudentSearch)}`;
    }
    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Falha ao buscar alunos');
    state.adminStudents = await res.json();

    counter.textContent = `${state.adminStudents.length} aluno(s) cadastrado(s)`;

    if (state.adminStudents.length === 0) {
      container.innerHTML = '<p class="text-muted" style="text-align:center; padding:20px;">Nenhum aluno encontrado.</p>';
      return;
    }

    container.innerHTML = state.adminStudents.map(st => {
      const subjectsBadges = (st.subjects || []).map(s => `<span class="subject-tag">${s.name}</span>`).join('') || '<span class="text-xs text-muted">Sem matérias</span>';

      return `
        <div class="teacher-card student-admin-card">
          <div class="teacher-card-header">
            <div style="flex:1; min-width:0;">
              <h4 style="font-size:1rem; font-weight:800; color:var(--brand-blue); margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${st.name}">${st.name}</h4>
              <span class="text-xs text-muted" style="display:block; margin-top:2px;">${st.objective_grade || 'Objetivo não informado'}${st.school_name ? ' • 🏫 ' + st.school_name : ''}</span>
              ${st.birthday_br ? `<span class="text-xs ${isBirthdayMonth(st.birth_date) ? 'birthday-highlight' : 'text-muted'}" style="display:block; margin-top:2px;">🎂 ${st.birthday_br}${isBirthdayMonth(st.birth_date) ? ' — aniversariante do mês!' : ''}</span>` : ''}
            </div>
            <span class="status-badge ${st.status || 'ativo'}">${st.status || 'ativo'}</span>
          </div>

          <div class="teacher-subjects-tags">
            ${subjectsBadges}
          </div>

          ${enrollmentSummaryHtml(st)}

          <div class="student-card-info-box">
            <div class="student-stat-pill">
              <span>Presenças: <strong>${st.total_presences || 0}</strong></span>
              <span class="stat-sep">•</span>
              <span>Faltas: <strong>${st.total_absences || 0}</strong></span>
            </div>
            <div class="student-parent-info">
              <span class="parent-label">👨‍👩‍👧 Responsável:</span> 
              <span class="parent-name">${st.parent_name || 'Não informado'}</span>
              <span class="hero-code-badge" style="font-size:0.72rem; padding:1px 6px; margin-left:2px;" title="Código de Acesso dos Pais">🔑 ${st.parent_access_code || ('PAIS-' + st.id)}</span>
            </div>
          </div>

          <div class="student-card-actions-wrapper">
            <div class="student-actions-grid">
              <button class="btn-action-pill btn-open-agenda-admin" data-id="${st.id}" title="Agenda e Recados para a Família">
                <span>📅</span> Agenda
              </button>
              <button class="btn-action-pill btn-preview-parent-admin" data-id="${st.id}" title="Visualizar Portal como a Família">
                <span>👁️</span> Portal Pais
              </button>
              <button class="btn-action-pill btn-open-report-admin" data-id="${st.id}" title="Ver relatório dia a dia">
                <span>📑</span> Relatório
              </button>
              <button class="btn-action-pill btn-edit-student-admin" data-id="${st.id}" title="Editar dados do aluno">
                <span>✏️</span> Editar
              </button>
              <button class="btn-action-pill btn-toggle-status-student-admin" data-id="${st.id}" data-status="${st.status || 'ativo'}" title="${(st.status || 'ativo') === 'ativo' ? 'Inativar aluno (sai da grade, mantém o histórico)' : 'Reativar aluno'}">
                <span>${(st.status || 'ativo') === 'ativo' ? '⏸️' : '▶️'}</span> ${(st.status || 'ativo') === 'ativo' ? 'Inativar' : 'Reativar'}
              </button>
              <button class="btn-action-pill danger btn-delete-student-admin" data-id="${st.id}" title="Remover aluno">
                <span>🗑️</span> Excluir
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-open-agenda-admin').forEach(b => {
      b.addEventListener('click', () => {
        openStudentAgendaModal(b.getAttribute('data-id'));
      });
    });

    container.querySelectorAll('.btn-preview-parent-admin').forEach(b => {
      b.addEventListener('click', () => {
        previewParentPortal(b.getAttribute('data-id'));
      });
    });

    container.querySelectorAll('.btn-open-report-admin').forEach(b => {
      b.addEventListener('click', () => {
        openStudentReportDirectly(b.getAttribute('data-id'));
      });
    });

    container.querySelectorAll('.btn-edit-student-admin').forEach(b => {
      b.addEventListener('click', () => openStudentModalAdmin(b.getAttribute('data-id')));
    });

    container.querySelectorAll('.btn-delete-student-admin').forEach(b => {
      b.addEventListener('click', () => handleDeleteStudent(b.getAttribute('data-id')));
    });

    container.querySelectorAll('.btn-toggle-status-student-admin').forEach(b => {
      b.addEventListener('click', () => handleToggleStudentStatus(b.getAttribute('data-id'), b.getAttribute('data-status')));
    });
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger); text-align:center;">${err.message}</p>`;
  }
}

function isBirthdayMonth(isoDate) {
  if (!isoDate) return false;
  return parseInt(String(isoDate).slice(5, 7)) === new Date().getMonth() + 1;
}

function handleToggleStudentStatus(studentId, currentStatus) {
  const activating = currentStatus !== 'ativo';
  const msg = activating
    ? 'Reativar este aluno? Ele volta a aparecer nas listas (os horários da grade precisam ser recriados).'
    : 'Inativar este aluno? Ele sai da grade de horários, mas todo o histórico (aulas, faturas, relatórios) é mantido.';
  showAppConfirm(msg, async () => {
    try {
      const res = await fetch(`${API_BASE}/api/students/${studentId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ status: activating ? 'ativo' : 'inativo' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao alterar status');
      showToast(activating ? 'Aluno reativado.' : 'Aluno inativado.');
      loadAdminStudents();
      loadStudents();
      loadStats();
      loadSchedules();
    } catch (err) {
      showAppAlert(err.message, 'Status do Aluno');
    }
  }, activating ? 'Reativar Aluno' : 'Inativar Aluno', !activating);
}

async function openStudentModalAdmin(studentId = null) {
  if (!state.teachers || state.teachers.length === 0) {
    try { await loadTeachers(); } catch (e) {}
  }
  if (!state.subjects || state.subjects.length === 0) {
    try { await loadSubjects(); } catch (e) {}
  }

  const modal = document.getElementById('modal-student-admin');
  const title = document.getElementById('student-modal-title');
  const form = document.getElementById('form-student-admin');
  form.reset();

  const cbContainer = document.getElementById('student-subjects-checkboxes');
  cbContainer.innerHTML = (state.subjects || []).map(s => `
    <label style="display:flex; align-items:center; gap:8px; font-size:0.85rem; margin-bottom:6px;">
      <input type="checkbox" name="admin_student_sub" value="${s.id}">
      <span>${s.name}</span>
    </label>
  `).join('');

  if (studentId) {
    const student = state.adminStudents.find(s => String(s.id) === String(studentId)) || state.students.find(s => String(s.id) === String(studentId));
    if (!student) return;

    title.textContent = 'Editar Aluno';
    document.getElementById('student-edit-id').value = student.id;
    document.getElementById('student-name').value = student.name;
    document.getElementById('student-grade').value = student.objective_grade || '';
    document.getElementById('student-start-date').value = student.start_date || '';
    document.getElementById('student-end-date').value = student.end_date || '';
    document.getElementById('student-status').value = student.status || 'ativo';
    document.getElementById('student-birth-date').value = student.birth_date ? String(student.birth_date).slice(0, 10) : '';
    document.getElementById('student-address').value = student.address || '';
    document.getElementById('student-school-name').value = student.school_name || '';
    document.getElementById('student-school-contact').value = student.school_contact_name || '';
    document.getElementById('student-school-phone').value = student.school_phone || '';

    if (document.getElementById('student-enrollment-notes')) {
      document.getElementById('student-enrollment-notes').value = student.enrollment_notes || '';
    }

    // Campos de Acesso dos Pais
    const parentNameEl = document.getElementById('student-parent-name');
    const parentPhoneEl = document.getElementById('student-parent-phone');
    const parentEmailEl = document.getElementById('student-parent-email');
    const parentCodeEl = document.getElementById('student-parent-code');
    if (parentNameEl) parentNameEl.value = student.parent_name || '';
    if (parentPhoneEl) parentPhoneEl.value = student.parent_phone || '';
    if (parentEmailEl) parentEmailEl.value = student.parent_email || '';
    if (parentCodeEl) parentCodeEl.value = student.parent_access_code || ('PAIS-' + student.id);

    const subIds = (student.subjects || []).map(s => s.id);
    document.querySelectorAll('input[name="admin_student_sub"]').forEach(cb => {
      if (subIds.includes(parseInt(cb.value))) cb.checked = true;
    });
    initEnrollmentTabs(student);
  } else {
    title.textContent = 'Cadastrar Novo Aluno';
    document.getElementById('student-edit-id').value = '';
    const parentCodeEl = document.getElementById('student-parent-code');
    if (parentCodeEl) parentCodeEl.value = 'PAIS-' + Math.floor(1000 + Math.random() * 9000);
    if (document.getElementById('student-enrollment-notes')) document.getElementById('student-enrollment-notes').value = '';
    initEnrollmentTabs(null);
  }

  modal.classList.remove('hidden');
}

// ==========================================
// MATRÍCULA POR MATÉRIA (abas no cadastro do aluno)
// Cada matéria marcada abre uma aba com um ou mais horários; cada horário tem professor,
// periodicidade, dias, horário, duração, início e observação. O servidor transforma cada
// horário em linhas da grade (uma por dia da semana).
// ==========================================
const ENR_DAYS = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [0, 'Dom']];
const ENR_DURATIONS = [30, 45, 60, 90, 120];
const enr = { slots: {}, active: null, saved: new Set() };

function enrMinutes(t) {
  const [h, m] = String(t || '').split(':').map(Number);
  return h * 60 + m;
}

function enrEndTime(start, duration) {
  const total = enrMinutes(start) + (parseInt(duration) || 0);
  if (!start || Number.isNaN(total) || total >= 24 * 60) return '';
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function enrTeachersFor(subjectId) {
  return (state.teachers || []).filter(t => t.role === 'professor' && t.status === 'ativo' &&
    (t.subjects || []).some(s => String(s.id) === String(subjectId)));
}

function enrNewSlot(subjectId) {
  const teachers = enrTeachersFor(subjectId);
  return {
    teacher_id: teachers.length === 1 ? String(teachers[0].id) : '',
    frequency_type: 'semanal', recurrence_interval_days: 3,
    days: [], start_time: '08:00', duration_minutes: 60,
    start_date: toIsoDateOnly(new Date()), notes: ''
  };
}

function enrSlotComplete(s) {
  return !!(s.teacher_id && s.days.length && /^\d{2}:\d{2}$/.test(s.start_time) &&
    enrEndTime(s.start_time, s.duration_minutes) &&
    (s.frequency_type !== 'custom_dias' || parseInt(s.recurrence_interval_days) >= 1));
}

// Resumo das matrículas no cartão do aluno: "Matemática · Fernando · Seg, Qua 14:00–15:00"
function enrollmentSummaryHtml(student) {
  const list = student.enrollments || [];
  if (list.length === 0) {
    return (student.status || 'ativo') === 'ativo'
      ? '<div class="enr-summary"><span class="enr-summary-empty">Sem horários na grade</span></div>'
      : '';
  }
  const dayLabel = Object.fromEntries(ENR_DAYS);
  const groups = new Map();
  list.forEach(e => {
    const key = [e.subject_id, e.teacher_id, e.start_time, e.end_time, e.frequency_type].join('|');
    if (!groups.has(key)) groups.set(key, { ...e, days: [] });
    groups.get(key).days.push(e.day_of_week);
  });
  const freqLabel = { quinzenal: ' · quinzenal', custom_dias: ' · a cada N dias' };
  return `<ul class="enr-summary">${[...groups.values()].map(g => {
    const days = ENR_DAYS.map(([d]) => d).filter(d => g.days.includes(d)).map(d => dayLabel[d]).join(', ');
    return `<li><strong>${escapeHtml(g.subject_name || 'Sem matéria')}</strong> · ${escapeHtml((g.teacher_name || '').split(' ')[0])} · ${days} ${g.start_time}–${g.end_time}${freqLabel[g.frequency_type] || ''}</li>`;
  }).join('')}</ul>`;
}

function enrCheckedSubjects() {
  return Array.from(document.querySelectorAll('input[name="admin_student_sub"]:checked')).map(cb => cb.value);
}

// Agrupa as linhas da grade do aluno em horários do formulário (mesma matéria, professor, faixa e periodicidade)
function initEnrollmentTabs(student) {
  enr.slots = {};
  enr.saved = new Set();
  const groups = new Map();
  ((student && student.enrollments) || []).forEach(e => {
    if (!e.subject_id) return;
    const key = [e.subject_id, e.teacher_id, e.start_time, e.end_time, e.frequency_type, e.recurrence_interval_days, e.notes || ''].join('|');
    if (!groups.has(key)) {
      const autoNote = /^(Matrícula:|Aula regular - Aluno)/.test(e.notes || '');
      groups.set(key, {
        subject_id: String(e.subject_id),
        teacher_id: String(e.teacher_id),
        frequency_type: e.frequency_type || 'semanal',
        recurrence_interval_days: e.recurrence_interval_days || 3,
        days: [], start_time: e.start_time,
        duration_minutes: enrMinutes(e.end_time) - enrMinutes(e.start_time),
        start_date: e.start_date || '', notes: autoNote ? '' : (e.notes || '')
      });
    }
    const g = groups.get(key);
    if (!g.days.includes(e.day_of_week)) g.days.push(e.day_of_week);
    if (e.start_date && (!g.start_date || e.start_date < g.start_date)) g.start_date = e.start_date;
  });
  groups.forEach(g => {
    const { subject_id, ...slot } = g;
    (enr.slots[subject_id] = enr.slots[subject_id] || []).push(slot);
    enr.saved.add(subject_id);
  });

  const checked = enrCheckedSubjects();
  checked.forEach(id => { if (!enr.slots[id]) enr.slots[id] = [enrNewSlot(id)]; });
  enr.active = checked[0] || null;

  document.querySelectorAll('input[name="admin_student_sub"]').forEach(cb => {
    cb.addEventListener('change', () => onEnrollmentSubjectToggle(cb));
  });
  renderEnrollmentTabs();
}

function onEnrollmentSubjectToggle(cb) {
  const id = cb.value;
  if (cb.checked) {
    if (!enr.slots[id] || enr.slots[id].length === 0) enr.slots[id] = [enrNewSlot(id)];
    enr.active = id;
    renderEnrollmentTabs();
    return;
  }
  const finish = () => {
    if (enr.active === id) enr.active = enrCheckedSubjects()[0] || null;
    renderEnrollmentTabs();
  };
  if (enr.saved.has(id)) {
    // Desmarcar uma matéria que já está na grade tira os horários dela ao salvar
    cb.checked = true;
    const name = (state.subjects.find(s => String(s.id) === id) || {}).name || 'esta matéria';
    showAppConfirm(`Ao salvar, os horários de ${name} deste aluno saem da grade. Deseja remover a matéria?`, () => {
      cb.checked = false;
      finish();
    }, 'Remover Matéria', true);
    return;
  }
  finish();
}

function renderEnrollmentTabs() {
  const tabsEl = document.getElementById('enr-tabs');
  const panelEl = document.getElementById('enr-panel');
  if (!tabsEl || !panelEl) return;
  const checked = enrCheckedSubjects();

  if (checked.length === 0) {
    tabsEl.innerHTML = '';
    panelEl.innerHTML = '<p class="enr-empty">Marque ao menos uma matéria acima. Cada matéria abre uma aba para definir professor, dias e horário das aulas.</p>';
    return;
  }
  if (!checked.includes(enr.active)) enr.active = checked[0];

  tabsEl.innerHTML = checked.map(id => {
    const name = (state.subjects.find(s => String(s.id) === id) || {}).name || 'Matéria';
    const ok = (enr.slots[id] || []).length > 0 && enr.slots[id].every(enrSlotComplete);
    return `<button type="button" role="tab" class="enr-tab ${id === enr.active ? 'active' : ''}" data-sub="${id}" aria-selected="${id === enr.active}">
      <span class="enr-tab-name">${escapeHtml(name)}</span>
      <span class="enr-tab-status ${ok ? 'ok' : 'pending'}" data-status-for="${id}" aria-label="${ok ? 'completa' : 'falta preencher'}">${ok ? '✓' : '!'}</span>
    </button>`;
  }).join('');

  const subId = enr.active;
  const teachers = enrTeachersFor(subId);
  const slots = enr.slots[subId] || [];
  panelEl.innerHTML = `
    ${teachers.length === 0 ? `<p class="enr-warning">Nenhum professor ativo leciona esta matéria. Vincule a matéria a um professor em Gestão &gt; Professores.</p>` : ''}
    ${slots.map((s, i) => `
      <div class="enr-slot" data-index="${i}">
        <div class="enr-slot-head">
          <strong>Horário ${i + 1}</strong>
          ${slots.length > 1 ? `<button type="button" class="enr-slot-remove" data-action="remove" data-index="${i}" aria-label="Remover horário ${i + 1}">Remover</button>` : ''}
        </div>
        <div class="form-group">
          <label>Professor *</label>
          <select data-field="teacher_id" data-index="${i}">
            <option value="">Selecione o professor</option>
            ${teachers.map(t => `<option value="${t.id}" ${String(t.id) === String(s.teacher_id) ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group flex-1">
            <label>Periodicidade *</label>
            <select data-field="frequency_type" data-index="${i}">
              <option value="semanal" ${s.frequency_type === 'semanal' ? 'selected' : ''}>Semanal (toda semana)</option>
              <option value="quinzenal" ${s.frequency_type === 'quinzenal' ? 'selected' : ''}>Quinzenal (semana sim, semana não)</option>
              <option value="custom_dias" ${s.frequency_type === 'custom_dias' ? 'selected' : ''}>A cada X dias</option>
            </select>
          </div>
          <div class="form-group flex-1 ${s.frequency_type === 'custom_dias' ? '' : 'hidden'}" data-custom-for="${i}">
            <label>A cada quantos dias? *</label>
            <input type="number" min="1" max="60" data-field="recurrence_interval_days" data-index="${i}" value="${s.recurrence_interval_days || 3}">
          </div>
        </div>
        <div class="form-group">
          <label>Dias da semana *</label>
          <div class="weekday-selector-chips">
            ${ENR_DAYS.map(([d, label]) => `<label class="weekday-chip"><input type="checkbox" data-field="days" data-index="${i}" value="${d}" ${s.days.includes(d) ? 'checked' : ''}> <span>${label}</span></label>`).join('')}
          </div>
        </div>
        <div class="form-row">
          <div class="form-group flex-1">
            <label>Horário *</label>
            <input type="time" data-field="start_time" data-index="${i}" value="${s.start_time || ''}">
          </div>
          <div class="form-group flex-1">
            <label>Duração *</label>
            <select data-field="duration_minutes" data-index="${i}">
              ${[...new Set([...ENR_DURATIONS, parseInt(s.duration_minutes) || 60])].sort((a, b) => a - b)
                .map(m => `<option value="${m}" ${m === parseInt(s.duration_minutes) ? 'selected' : ''}>${m} min</option>`).join('')}
            </select>
            <small class="text-xs text-muted" data-end-for="${i}">${enrEndTime(s.start_time, s.duration_minutes) ? 'Termina às ' + enrEndTime(s.start_time, s.duration_minutes) : 'Passa da meia-noite'}</small>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group flex-1">
            <label>Início das aulas</label>
            <input type="date" data-field="start_date" data-index="${i}" value="${s.start_date || ''}">
          </div>
          <div class="form-group flex-1">
            <label>Observação</label>
            <input type="text" data-field="notes" data-index="${i}" value="${escapeHtml(s.notes || '')}" placeholder="Ex: foco em frações">
          </div>
        </div>
      </div>
    `).join('')}
    <button type="button" class="enr-add" data-action="add">+ Adicionar outro horário nesta matéria</button>
  `;
}

function refreshEnrollmentStatus(subId) {
  const el = document.querySelector(`#enr-tabs [data-status-for="${subId}"]`);
  if (!el) return;
  const ok = (enr.slots[subId] || []).length > 0 && enr.slots[subId].every(enrSlotComplete);
  el.className = `enr-tab-status ${ok ? 'ok' : 'pending'}`;
  el.textContent = ok ? '✓' : '!';
  el.setAttribute('aria-label', ok ? 'completa' : 'falta preencher');
}

function setupEnrollmentTabs() {
  const tabsEl = document.getElementById('enr-tabs');
  const panelEl = document.getElementById('enr-panel');
  if (!tabsEl || !panelEl) return;

  tabsEl.addEventListener('click', e => {
    const tab = e.target.closest('.enr-tab');
    if (!tab) return;
    enr.active = tab.dataset.sub;
    renderEnrollmentTabs();
  });

  panelEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const slots = enr.slots[enr.active] || [];
    if (btn.dataset.action === 'add') slots.push(enrNewSlot(enr.active));
    if (btn.dataset.action === 'remove') slots.splice(parseInt(btn.dataset.index), 1);
    enr.slots[enr.active] = slots;
    renderEnrollmentTabs();
  });

  const onField = e => {
    const el = e.target;
    const field = el.dataset.field;
    if (!field) return;
    const i = parseInt(el.dataset.index);
    const slot = (enr.slots[enr.active] || [])[i];
    if (!slot) return;
    if (field === 'days') {
      const d = parseInt(el.value);
      slot.days = el.checked ? [...new Set([...slot.days, d])] : slot.days.filter(x => x !== d);
    } else {
      slot[field] = el.value;
    }
    if (field === 'frequency_type') {
      panelEl.querySelector(`[data-custom-for="${i}"]`).classList.toggle('hidden', el.value !== 'custom_dias');
    }
    if (field === 'start_time' || field === 'duration_minutes') {
      const end = enrEndTime(slot.start_time, slot.duration_minutes);
      panelEl.querySelector(`[data-end-for="${i}"]`).textContent = end ? 'Termina às ' + end : 'Passa da meia-noite';
    }
    refreshEnrollmentStatus(enr.active);
  };
  panelEl.addEventListener('input', onField);
  panelEl.addEventListener('change', onField);
}

// Monta os horários para o envio. Retorna { enrollments } ou { error, subjectId }.
function collectEnrollments() {
  const checked = enrCheckedSubjects();
  if (checked.length === 0) return { error: 'Selecione ao menos uma matéria e preencha a matrícula dela.' };
  const enrollments = [];
  for (const id of checked) {
    const slots = enr.slots[id] || [];
    const name = (state.subjects.find(s => String(s.id) === id) || {}).name || 'matéria';
    const bad = slots.findIndex(s => !enrSlotComplete(s));
    if (slots.length === 0 || bad >= 0) {
      return { error: `Complete a matrícula de ${name}${bad >= 0 && slots.length > 1 ? ` (horário ${bad + 1})` : ''}: professor, dias da semana, horário e duração são obrigatórios.`, subjectId: id };
    }
    slots.forEach(s => enrollments.push({
      subject_id: parseInt(id),
      teacher_id: parseInt(s.teacher_id),
      frequency_type: s.frequency_type,
      recurrence_interval_days: parseInt(s.recurrence_interval_days) || null,
      days: s.days,
      start_time: s.start_time,
      duration_minutes: parseInt(s.duration_minutes),
      start_date: s.start_date || null,
      notes: s.notes || ''
    }));
  }
  return { enrollments };
}

async function handleDeleteStudent(studentId) {
  showAppConfirm('Tem certeza de que deseja remover este aluno? Se ele já tiver aulas, faturas ou tarefas registradas, será apenas inativado para preservar o histórico.', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/students/${studentId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao remover aluno');
      if (data.soft_deleted) showAppAlert(data.message, 'Aluno Inativado');
      else showToast('Aluno removido com sucesso!');
      loadAdminStudents();
      loadStudents();
      loadStats();
    } catch (err) {
      showAppAlert(err.message, 'Erro ao Remover Aluno');
    }
  }, 'Remover Aluno', true);
}

// ==========================================
// PAINEL ADMIN: GESTÃO DE MATÉRIAS / TURMAS
// ==========================================
async function loadAdminSubjects() {
  const container = document.getElementById('admin-subjects-cards-list');
  const counter = document.getElementById('admin-subjects-counter');
  if (!container) return;

  container.innerHTML = '<div style="text-align:center; padding: 20px;">Carregando matérias...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/subjects`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Falha ao carregar matérias');
    state.subjects = await res.json();

    renderAdminSubjectsList();
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger); text-align:center;">${err.message}</p>`;
  }
}

function renderAdminSubjectsList() {
  const container = document.getElementById('admin-subjects-cards-list');
  const counter = document.getElementById('admin-subjects-counter');
  if (!container) return;

  let list = state.subjects || [];
  if (state.adminSubjectSearch) {
    const q = state.adminSubjectSearch.toLowerCase().trim();
    list = list.filter(s => s.name.toLowerCase().includes(q) || (s.code && s.code.toLowerCase().includes(q)));
  }

  counter.textContent = `${list.length} matéria(s) cadastrada(s)`;

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:30px; color:var(--text-dim);">
        <p style="font-size:1rem; margin-bottom:6px;">Nenhuma matéria encontrada.</p>
        <span class="text-xs">Cadastre uma nova matéria clicando no botão "➕ Nova Matéria" acima.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = list.map(sub => {
    return `
      <div class="teacher-card">
        <div class="teacher-card-header">
          <div class="teacher-title-box">
            <div class="teacher-avatar-circle" style="background: var(--brand-sky); color: #fff;">
              📚
            </div>
            <div class="teacher-name-box">
              <h4>${sub.name}</h4>
              <span class="text-xs text-muted" style="font-family: monospace;">código: ${sub.code}</span>
              <div class="classroom-badges-row" style="margin-top: 4px;">
                ${sub.classroom_name ? `<span class="classroom-pill type-presencial">🏛️ ${sub.classroom_name}</span>` : ''}
                ${sub.max_students ? `<span class="classroom-pill cap-students">👥 Máx. ${sub.max_students} alunos/horário</span>` : ''}
                ${sub.total_lessons ? `<span class="classroom-pill cap-teachers">⏱️ ${sub.total_lessons} aulas</span>` : ''}
              </div>
              ${(Array.isArray(sub.required_resources) && sub.required_resources.length > 0) ? `
                <div style="margin-top: 4px;">
                  <span class="text-xs text-muted">Recursos: </span>
                  ${sub.required_resources.map(r => `<span class="resource-tag">✓ ${r}</span>`).join(' ')}
                </div>
              ` : ''}
            </div>
          </div>
          <span class="status-badge ativo">Ativa</span>
        </div>

        <div class="teacher-card-actions" style="margin-top: 6px;">
          <span class="teacher-meta-count">
            👨‍🎓 ${sub.student_count || 0} alunos vinculados • 📝 ${sub.total_logs || 0} aulas registradas
          </span>
          <div class="btn-card-group">
            <button class="btn-action-sm btn-edit-subject-admin" data-id="${sub.id}">✏️ Editar</button>
            <button class="btn-action-sm danger btn-delete-subject-admin" data-id="${sub.id}" data-name="${sub.name}">🗑️ Excluir</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-edit-subject-admin').forEach(btn => {
    btn.addEventListener('click', () => openSubjectModalAdmin(btn.getAttribute('data-id')));
  });

  container.querySelectorAll('.btn-delete-subject-admin').forEach(btn => {
    btn.addEventListener('click', () => handleDeleteSubject(btn.getAttribute('data-id'), btn.getAttribute('data-name')));
  });
}

function openSubjectModalAdmin(subjectId = null) {
  const modal = document.getElementById('modal-subject-admin');
  const title = document.getElementById('subject-modal-title');
  const form = document.getElementById('form-subject-admin');
  form.reset();

  const roomSelect = document.getElementById('subject-classroom-id');
  if (roomSelect) {
    roomSelect.innerHTML = '<option value="">-- Nenhuma sala vinculada (Sem restrição padrão) --</option>' + 
      (state.classrooms || []).map(r => `
        <option value="${r.id}">${r.type === 'presencial' ? '🏫' : '🌐'} ${r.name} (Capacidade: ${r.capacity_students} alunos)</option>
      `).join('');
  }

  if (subjectId) {
    const sub = (state.subjects || []).find(s => String(s.id) === String(subjectId));
    if (!sub) return;

    title.textContent = 'Editar Matéria';
    document.getElementById('subject-edit-id').value = sub.id;
    document.getElementById('subject-name').value = sub.name;
    document.getElementById('subject-code').value = sub.code || '';
    if (roomSelect) roomSelect.value = sub.classroom_id || '';
    document.getElementById('subject-max-students').value = sub.max_students || '';
    document.getElementById('subject-total-lessons').value = sub.total_lessons || '';
    document.getElementById('subject-required-resources').value = Array.isArray(sub.required_resources) ? sub.required_resources.join(', ') : '';
  } else {
    title.textContent = 'Cadastrar Nova Matéria';
    document.getElementById('subject-edit-id').value = '';
    document.getElementById('subject-name').value = '';
    document.getElementById('subject-code').value = '';
    if (roomSelect) roomSelect.value = '';
    document.getElementById('subject-max-students').value = '';
    document.getElementById('subject-total-lessons').value = '';
    document.getElementById('subject-required-resources').value = '';
  }

  modal.classList.remove('hidden');
}

function closeSubjectModalAdmin() {
  document.getElementById('modal-subject-admin').classList.add('hidden');
}

async function handleDeleteSubject(subjectId, subjectName) {
  showAppConfirm(`Tem certeza de que deseja excluir a matéria "${subjectName || ''}"?`, async () => {
    try {
      const res = await fetch(`${API_BASE}/api/subjects/${subjectId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao excluir matéria');

      showToast('Matéria excluída com sucesso!');
      await loadSubjects();
      loadAdminSubjects();
      loadStudents();
    } catch (err) {
      showAppAlert(err.message, 'Erro ao Excluir Matéria');
    }
  }, 'Excluir Matéria', true);
}

// ==========================================
// PAINEL ADMIN: GESTÃO DE SALAS & RECURSOS
// ==========================================
async function loadClassrooms() {
  const container = document.getElementById('admin-classrooms-cards-list');
  const counter = document.getElementById('admin-classrooms-counter');
  if (container) {
    container.innerHTML = '<div style="text-align:center; padding: 20px;">Carregando salas e recursos...</div>';
  }

  try {
    const res = await fetch(`${API_BASE}/api/classrooms`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Falha ao carregar salas');
    state.classrooms = await res.json();

    renderClassroomsList();
    populateClassroomSelects();
  } catch (err) {
    if (container) {
      container.innerHTML = `<p style="color:var(--danger); text-align:center;">${err.message}</p>`;
    }
  }
}

function populateClassroomSelects() {
  const subjectClassroomSelect = document.getElementById('subject-classroom-id');
  if (subjectClassroomSelect) {
    const currentVal = subjectClassroomSelect.value;
    subjectClassroomSelect.innerHTML = '<option value="">-- Nenhuma sala vinculada (Sem restrição padrão) --</option>' + 
      (state.classrooms || []).map(r => `
        <option value="${r.id}">${r.type === 'presencial' ? '🏫' : '🌐'} ${r.name} (Capacidade: ${r.capacity_students} alunos)</option>
      `).join('');
    if (currentVal) subjectClassroomSelect.value = currentVal;
  }

  const schedClassroomSelect = document.getElementById('sched-classroom-id');
  if (schedClassroomSelect) {
    const currentVal = schedClassroomSelect.value;
    schedClassroomSelect.innerHTML = (state.classrooms || []).map(r => `
      <option value="${r.id}">${r.type === 'presencial' ? '🏫' : '🌐'} ${r.name} (${r.capacity_students} alunos máx.)</option>
    `).join('');
    if (currentVal) schedClassroomSelect.value = currentVal;
  }

  const entryClassroomSelect = document.getElementById('entry-classroom-id');
  if (entryClassroomSelect) {
    const currentVal = entryClassroomSelect.value;
    entryClassroomSelect.innerHTML = (state.classrooms || []).map(r => `
      <option value="${r.id}">${r.type === 'presencial' ? '🏫' : '🌐'} ${r.name}</option>
    `).join('');
    if (currentVal) entryClassroomSelect.value = currentVal;
  }
}

function renderClassroomsList() {
  const container = document.getElementById('admin-classrooms-cards-list');
  const counter = document.getElementById('admin-classrooms-counter');
  if (!container) return;

  let list = state.classrooms || [];
  if (state.adminClassroomSearch) {
    const q = state.adminClassroomSearch.toLowerCase().trim();
    list = list.filter(r => 
      r.name.toLowerCase().includes(q) || 
      (r.type && r.type.toLowerCase().includes(q)) ||
      (Array.isArray(r.resources) && r.resources.some(res => getResourceName(res).toLowerCase().includes(q)))
    );
  }

  if (counter) counter.textContent = `${list.length} sala(s) cadastrada(s)`;

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:30px; color:var(--text-dim);">
        <p style="font-size:1rem; margin-bottom:6px;">Nenhuma sala encontrada.</p>
        <span class="text-xs">Cadastre uma nova sala clicando em "➕ Nova Sala" acima.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = list.map(room => {
    const isOnline = room.type === 'online';
    const icon = isOnline ? '🌐' : '🏫';
    const resourcesList = Array.isArray(room.resources) ? room.resources : [];

    return `
      <div class="classroom-card">
        <div class="classroom-card-header">
          <div class="classroom-title-box">
            <div class="classroom-avatar-icon ${isOnline ? 'online' : ''}">
              ${icon}
            </div>
            <div class="classroom-name-box">
              <h4>${room.name}</h4>
              <div class="classroom-badges-row">
                <span class="classroom-pill ${isOnline ? 'type-online' : 'type-presencial'}">
                  ${isOnline ? '🌐 Virtual / Online' : '🏫 Presencial'}
                </span>
                <span class="classroom-pill cap-students">
                  👥 Até ${room.capacity_students} alunos
                </span>
                <span class="classroom-pill cap-teachers">
                  👨‍🏫 Até ${room.capacity_teachers} prof.
                </span>
                <span class="status-badge ativo">Ativa</span>
              </div>
            </div>
          </div>
        </div>

        ${room.description ? `
          <div class="classroom-desc">
            ${room.description}
          </div>
        ` : ''}

        <div>
          <span class="text-xs text-muted" style="font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Recursos Disponíveis:</span>
          <div class="classroom-resources-tags">
            ${resourcesList.length > 0 
              ? resourcesList.map(r => `<span class="resource-tag">✓ ${getResourceName(r)}</span>`).join('') 
              : '<span class="text-xs text-dim">Nenhum recurso específico cadastrado</span>'}
          </div>
        </div>

        <div class="classroom-card-actions">
          <span class="text-xs text-muted">
            📅 ${room.active_schedules_count || 0} horários na grade
          </span>
          <div class="btn-card-group">
            <button class="btn-action-sm btn-edit-classroom-admin" data-id="${room.id}">✏️ Editar</button>
            <button class="btn-action-sm danger btn-delete-classroom-admin" data-id="${room.id}" data-name="${room.name}">🗑️ Excluir</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-edit-classroom-admin').forEach(btn => {
    btn.addEventListener('click', () => openClassroomModalAdmin(btn.getAttribute('data-id')));
  });

  container.querySelectorAll('.btn-delete-classroom-admin').forEach(btn => {
    btn.addEventListener('click', () => handleDeleteClassroom(btn.getAttribute('data-id'), btn.getAttribute('data-name')));
  });
}

function openClassroomModalAdmin(classroomId = null) {
  const modal = document.getElementById('modal-classroom-admin');
  const title = document.getElementById('classroom-modal-title');
  const form = document.getElementById('form-classroom-admin');
  form.reset();

  const checkboxes = form.querySelectorAll('input[name="classroom_res"]');
  checkboxes.forEach(cb => { cb.checked = false; });
  document.getElementById('classroom-custom-resources').value = '';

  if (classroomId) {
    const room = (state.classrooms || []).find(r => String(r.id) === String(classroomId));
    if (!room) return;

    title.textContent = 'Editar Sala';
    document.getElementById('classroom-edit-id').value = room.id;
    document.getElementById('classroom-name').value = room.name;
    document.getElementById('classroom-type').value = room.type || 'presencial';
    document.getElementById('classroom-capacity-students').value = room.capacity_students || 4;
    document.getElementById('classroom-capacity-teachers').value = room.capacity_teachers || 1;
    document.getElementById('classroom-description').value = room.description || '';

    const resList = Array.isArray(room.resources) ? room.resources : [];
    const customList = [];
    resList.forEach(r => {
      const rName = getResourceName(r);
      if (!rName) return;
      let matched = false;
      checkboxes.forEach(cb => {
        if (cb.value.toLowerCase() === rName.toLowerCase()) {
          cb.checked = true;
          matched = true;
        }
      });
      if (!matched) customList.push(rName);
    });
    if (customList.length > 0) {
      document.getElementById('classroom-custom-resources').value = customList.join(', ');
    }
  } else {
    title.textContent = 'Cadastrar Nova Sala';
    document.getElementById('classroom-edit-id').value = '';
    document.getElementById('classroom-type').value = 'presencial';
    document.getElementById('classroom-capacity-students').value = 4;
    document.getElementById('classroom-capacity-teachers').value = 1;
    document.getElementById('classroom-description').value = '';
  }

  modal.classList.remove('hidden');
}

function closeClassroomModalAdmin() {
  document.getElementById('modal-classroom-admin').classList.add('hidden');
}

async function handleDeleteClassroom(classroomId, classroomName) {
  showAppConfirm(`Tem certeza de que deseja excluir a sala "${classroomName || ''}"?`, async () => {
    try {
      const res = await fetch(`${API_BASE}/api/classrooms/${classroomId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao excluir sala');

      showToast('Sala excluída com sucesso!');
      await loadClassrooms();
    } catch (err) {
      showAppAlert(err.message, 'Erro ao Excluir Sala');
    }
  }, 'Excluir Sala', true);
}

function updateEntryResourcesChips(classroomId, preselected = []) {
  const container = document.getElementById('entry-resources-chips');
  const hiddenInput = document.getElementById('entry-resources-used');
  if (!container || !hiddenInput) return;

  container.innerHTML = '';
  const room = (state.classrooms || []).find(r => String(r.id) === String(classroomId));
  const resources = room && Array.isArray(room.resources) ? room.resources : [];

  if (resources.length === 0) {
    container.innerHTML = '<span class="text-xs text-muted">Nenhum recurso específico cadastrado para esta sala.</span>';
    hiddenInput.value = JSON.stringify([]);
    return;
  }

  const activeResources = Array.isArray(preselected) ? preselected.map(s => String(s).toLowerCase()) : [];

  resources.forEach(rawRes => {
    const resName = getResourceName(rawRes);
    if (!resName) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'resource-chip-toggle';
    if (activeResources.includes(resName.toLowerCase())) {
      chip.classList.add('active');
    }
    chip.innerHTML = `<span>📦 ${resName}</span>`;
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      chip.classList.toggle('active');
      const currentActive = Array.from(container.querySelectorAll('.resource-chip-toggle.active'))
        .map(b => b.textContent.replace('📦', '').trim());
      hiddenInput.value = JSON.stringify(currentActive);
    });
    container.appendChild(chip);
  });

  const initialActive = Array.from(container.querySelectorAll('.resource-chip-toggle.active'))
    .map(b => b.textContent.replace('📦', '').trim());
  hiddenInput.value = JSON.stringify(initialActive);
}

// ==========================================
// MODAL DE LANÇAMENTO DE AULA
// ==========================================
async function openClassEntryModal(studentId, defaultSubjectId = null, defaultDate = null, defaultTime = null, editLog = null) {
  let student = (state.students || []).find(s => String(s.id) === String(studentId)) || (state.adminStudents || []).find(s => String(s.id) === String(studentId));
  if (!student) {
    try {
      const res = await fetch(`${API_BASE}/api/students/${studentId}`, { headers: getAuthHeaders() });
      if (res.ok) {
        const stData = await res.json();
        student = stData.student || stData;
      }
    } catch (e) {
      console.warn('Could not fetch student directly:', e);
    }
  }
  if (!student) return;

  const editIdInput = document.getElementById('entry-log-edit-id');
  if (editIdInput) editIdInput.value = editLog ? editLog.id : '';

  const modalTitle = document.querySelector('#modal-class-entry .sheet-header h3');
  if (modalTitle) {
    modalTitle.textContent = editLog ? '✏️ Editar Diário de Aula' : 'Novo Lançamento de Aula';
  }
  const btnSubmit = document.getElementById('btn-save-entry');
  if (btnSubmit) {
    btnSubmit.innerHTML = editLog ? '<span>💾 Atualizar Diário</span>' : '<span>💾 Gravar Aula</span>';
  }

  document.getElementById('modal-entry-student-name').textContent = student.name;
  document.getElementById('modal-entry-subtitle').textContent = student.objective_grade || 'Diário de Classe';
  document.getElementById('entry-student-id').value = student.id;

  const select = document.getElementById('entry-subject-id');
  select.innerHTML = '';
  
  const isProf = state.currentUser && state.currentUser.role === 'professor';
  const profSubjectIds = isProf && state.currentUser.subjects ? state.currentUser.subjects.map(s => s.id) : null;

  // Só matérias em que o aluno está matriculado (e, para professor, que ele leciona) — mesma regra do backend
  const subjectsToUse = student.subjects || [];

  let validOptionCount = 0;
  subjectsToUse.forEach(sub => {
    if (profSubjectIds && !profSubjectIds.includes(sub.id)) {
      return;
    }
    validOptionCount++;
    const opt = document.createElement('option');
    opt.value = sub.id;
    opt.textContent = sub.name;
    if (defaultSubjectId && String(sub.id) === String(defaultSubjectId)) {
      opt.selected = true;
    } else if (!defaultSubjectId && state.selectedSubjectId === String(sub.id)) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  if (editLog && !Array.from(select.options).some(o => String(o.value) === String(editLog.subject_id))) {
    const opt = document.createElement('option');
    opt.value = editLog.subject_id;
    opt.textContent = editLog.subject_name || 'Matéria do lançamento';
    select.appendChild(opt);
    validOptionCount++;
  }
  if (editLog) select.value = editLog.subject_id;
  // A matéria de um lançamento já gravado não muda na edição
  select.disabled = Boolean(editLog);

  if (validOptionCount === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = isProf
      ? 'Você não leciona nenhuma matéria em que este aluno está matriculado'
      : 'Aluno sem matéria matriculada — ajuste a matrícula em Gestão > Alunos';
    select.appendChild(opt);
  }

  // Popula e configura a sala no diário
  const entryClassroomSelect = document.getElementById('entry-classroom-id');
  if (entryClassroomSelect) {
    entryClassroomSelect.innerHTML = (state.classrooms || []).map(r => `
      <option value="${r.id}">${r.type === 'presencial' ? '🏫' : '🌐'} ${r.name}</option>
    `).join('');

    const selectedSub = (state.subjects || []).find(s => String(s.id) === String(select.value));
    let targetClassroomId = editLog ? editLog.classroom_id : (selectedSub ? selectedSub.classroom_id : null);
    if (!targetClassroomId && state.classrooms.length > 0) {
      targetClassroomId = state.classrooms[0].id;
    }

    if (targetClassroomId) {
      entryClassroomSelect.value = targetClassroomId;
    }

    const preselectedResources = editLog 
      ? (editLog.resources_used || []) 
      : (selectedSub && selectedSub.required_resources ? selectedSub.required_resources : []);

    updateEntryResourcesChips(entryClassroomSelect.value, preselectedResources);
  }

  const spNow = getSaoPauloDateAndTimeString();
  const timeInput = document.getElementById('entry-time');

  if (editLog) {
    document.getElementById('entry-date').value = editLog.class_date ? editLog.class_date.split('T')[0] : (defaultDate || spNow.dateIso);
    if (timeInput) {
      timeInput.value = editLog.class_time ? editLog.class_time.substring(0, 5) : (defaultTime || spNow.timeStr);
    }
    if (state.currentUser) {
      document.getElementById('entry-teacher').value = editLog.teacher_name || state.currentUser.name;
      document.getElementById('entry-teacher-display').textContent = (state.currentUser.role === 'admin' ? '👑 ' : '👨‍🏫 ') + (editLog.teacher_name || state.currentUser.name);
    }
    setEntryStatus(editLog.status || 'presente');
    document.getElementById('entry-content').value = editLog.content || '';
    document.getElementById('entry-incidents').value = editLog.incidents || 'Sem intercorrências';
    document.getElementById('entry-pedagogical').value = editLog.pedagogical_notes || '';
  } else {
    document.getElementById('entry-date').value = defaultDate || spNow.dateIso;
    if (timeInput) {
      timeInput.value = defaultTime || spNow.timeStr;
    }
    if (state.currentUser) {
      document.getElementById('entry-teacher').value = state.currentUser.name;
      document.getElementById('entry-teacher-display').textContent = (state.currentUser.role === 'admin' ? '👑 ' : '👨‍🏫 ') + state.currentUser.name;
    }
    setEntryStatus('presente');
    document.getElementById('entry-content').value = '';
    document.getElementById('entry-incidents').value = 'Sem intercorrências';
    document.getElementById('entry-pedagogical').value = '';
  }

  document.getElementById('modal-class-entry').classList.remove('hidden');
}

function closeClassEntryModal() {
  document.getElementById('modal-class-entry').classList.add('hidden');
}

function setEntryStatus(status) {
  state.currentEntryStatus = status;
  const btnPres = document.getElementById('btn-toggle-presente');
  const btnFalta = document.getElementById('btn-toggle-falta');
  const groupContent = document.getElementById('group-content');
  const inputIncidents = document.getElementById('entry-incidents');

  if (status === 'presente') {
    btnPres.classList.add('active');
    btnFalta.classList.remove('active');
    groupContent.style.opacity = '1';
    if (inputIncidents.value === 'Aluno faltou') inputIncidents.value = 'Sem intercorrências';
  } else {
    btnPres.classList.remove('active');
    btnFalta.classList.add('active');
    groupContent.style.opacity = '0.5';
    inputIncidents.value = 'Aluno faltou';
  }
}

// ==========================================
// MODAL DE HISTÓRICO (TIMELINE)
// ==========================================
async function openStudentHistoryModal(studentId) {
  const modal = document.getElementById('modal-student-history');
  const timeline = document.getElementById('student-timeline');
  const nameEl = document.getElementById('history-modal-student-name');
  const metaEl = document.getElementById('history-modal-meta');

  timeline.innerHTML = '<div style="text-align:center; padding: 20px;">Carregando histórico...</div>';
  modal.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/students/${studentId}`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Falha ao carregar aluno');
    const { student, logs } = await res.json();

    nameEl.textContent = student.name;
    metaEl.textContent = `${student.objective_grade || ''} (Início: ${student.start_date || 'N/I'})`;

    if (logs.length === 0) {
      timeline.innerHTML = '<p style="text-align:center; color: var(--text-dim); padding: 20px;">Nenhuma aula registrada ainda.</p>';
      return;
    }

    timeline.innerHTML = logs.map(log => `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        ${createLogCardHTML(log)}
      </div>
    `).join('');
  } catch (err) {
    timeline.innerHTML = '<p style="color: var(--danger); text-align:center;">Erro ao carregar histórico.</p>';
  }
}

function closeStudentHistoryModal() {
  document.getElementById('modal-student-history').classList.add('hidden');
}

// ==========================================
// LISTENERS & EVENTOS
// ==========================================
function setupEventListeners() {
  setupWebsiteEvents();
  setupEducationalPortalEvents();

  // Alternar Modo de Login (Equipe Escolar vs Portal da Família)
  const tabLoginSchool = document.getElementById('tab-login-school');
  const tabLoginParent = document.getElementById('tab-login-parent');
  const formLogin = document.getElementById('form-login');
  const formParentLogin = document.getElementById('form-parent-login');

  if (tabLoginSchool && tabLoginParent) {
    tabLoginSchool.addEventListener('click', () => {
      tabLoginSchool.classList.add('active');
      tabLoginParent.classList.remove('active');
      formLogin.classList.remove('hidden');
      formParentLogin.classList.add('hidden');
    });

    tabLoginParent.addEventListener('click', () => {
      tabLoginParent.classList.add('active');
      tabLoginSchool.classList.remove('active');
      formParentLogin.classList.remove('hidden');
      formLogin.classList.add('hidden');
    });
  }

  // Login Form (Equipe Escolar)
  document.getElementById('form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-password').value;
    handleLogin(email, pass);
  });

  // Formulário de Login dos Pais (Portal da Família)
  if (formParentLogin) {
    formParentLogin.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = document.getElementById('parent-access-code').value;
      const pass = document.getElementById('parent-password').value;
      handleParentLogin(code, pass);
    });
  }


  // Navegação no Portal dos Pais (Desktop e Mobile)
  document.querySelectorAll('[data-parent-subtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetSubtab = btn.getAttribute('data-parent-subtab');
      switchParentSubtab(targetSubtab);
    });
  });

  // Abas segmentadas dentro do Portal dos Pais
  document.querySelectorAll('.parent-segmented-tabs .parent-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetSubtab = btn.getAttribute('data-subview');
      switchParentSubtab(targetSubtab);
    });
  });

  // Filtros de Categoria da Agenda dos Pais
  document.querySelectorAll('.agenda-filter-chips .chip-filter').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.agenda-filter-chips .chip-filter').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.parentActiveCategory = chip.getAttribute('data-cat') || '';
      renderParentAgenda();
    });
  });

  // Filtros de Dias da Grade dos Pais
  document.querySelectorAll('#parent-schedule-day-chips .chip-day').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#parent-schedule-day-chips .chip-day').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.parentActiveDay = chip.getAttribute('data-parent-day') || '';
      renderParentSchedules();
    });
  });

  // Modal da Agenda (Professores e Admin)
  const modalAgenda = document.getElementById('modal-student-agenda');
  const btnCloseAgenda = document.getElementById('btn-close-agenda-modal');
  if (btnCloseAgenda) {
    btnCloseAgenda.addEventListener('click', () => {
      modalAgenda.classList.add('hidden');
    });
  }

  // Formulário de adicionar recado na agenda
  const formAddAgenda = document.getElementById('form-add-agenda');
  if (formAddAgenda) {
    formAddAgenda.addEventListener('submit', handleAddAgendaSubmit);
  }

  // Chips rápidos de título na agenda
  document.querySelectorAll('[data-agenda-title]').forEach(btn => {
    btn.addEventListener('click', () => {
      const titleInput = document.getElementById('agenda-title');
      if (titleInput) titleInput.value = btn.getAttribute('data-agenda-title');
    });
  });

  // Gerar código de acesso dos pais
  const btnGenCode = document.getElementById('btn-generate-parent-code');
  if (btnGenCode) {
    btnGenCode.addEventListener('click', () => {
      const name = (document.getElementById('student-name').value || '').trim();
      const first = name ? name.split(' ')[0].toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z]/g, '') : 'ALUNO';
      document.getElementById('student-parent-code').value = 'PAIS-' + first;
    });
  }

  // Logout
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  // Busca de alunos na tela principal
  const inputSearch = document.getElementById('input-search');
  const clearBtn = document.getElementById('btn-clear-search');
  let searchTimeout;

  inputSearch.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    state.searchTerm = e.target.value;
    clearBtn.classList.toggle('hidden', !state.searchTerm);
    searchTimeout = setTimeout(() => {
      loadStudents();
    }, 250);
  });

  clearBtn.addEventListener('click', () => {
    inputSearch.value = '';
    state.searchTerm = '';
    clearBtn.classList.add('hidden');
    loadStudents();
  });

  // Busca de alunos no Painel Admin
  const adminStudentSearchInput = document.getElementById('input-admin-student-search');
  if (adminStudentSearchInput) {
    let adminSearchTimeout;
    adminStudentSearchInput.addEventListener('input', (e) => {
      clearTimeout(adminSearchTimeout);
      state.adminStudentSearch = e.target.value;
      adminSearchTimeout = setTimeout(() => {
        loadAdminStudents();
      }, 250);
    });
  }

  // Eventos da Aba de Relatórios
  const repSelect = document.getElementById('report-student-select');
  if (repSelect) {
    repSelect.addEventListener('change', (e) => {
      const studentId = e.target.value;
      if (studentId) {
        state.reportFilterSubjectId = '';
        loadStudentReport(studentId);
      } else {
        document.getElementById('report-empty-placeholder').classList.remove('hidden');
        document.getElementById('report-student-sheet').classList.add('hidden');
        document.getElementById('report-secondary-filters').style.display = 'none';
        document.getElementById('report-actions-strip').style.display = 'none';
      }
    });
  }

  const repSubjectFilter = document.getElementById('report-filter-subject');
  if (repSubjectFilter) {
    repSubjectFilter.addEventListener('change', (e) => {
      state.reportFilterSubjectId = e.target.value;
      if (state.selectedReportStudentId) {
        loadStudentReport(state.selectedReportStudentId);
      }
    });
  }

  const repOrderSelect = document.getElementById('report-sort-order');
  if (repOrderSelect) {
    repOrderSelect.addEventListener('change', (e) => {
      state.reportSortOrder = e.target.value;
      if (state.selectedReportStudentId) {
        loadStudentReport(state.selectedReportStudentId);
      }
    });
  }

  document.getElementById('btn-print-report').addEventListener('click', printReport);
  document.getElementById('btn-export-csv').addEventListener('click', exportReportCSV);

  // Toggles de presença/falta
  document.getElementById('btn-toggle-presente').addEventListener('click', () => setEntryStatus('presente'));
  document.getElementById('btn-toggle-falta').addEventListener('click', () => setEntryStatus('falta'));

  // Atalhos rápidos de conteúdo
  document.querySelectorAll('[data-fill]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-fill');
      const textarea = document.getElementById('entry-content');
      textarea.value = textarea.value ? `${textarea.value}; ${val}` : val;
    });
  });

  // Atalhos de intercorrência
  document.querySelectorAll('[data-incident]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('entry-incidents').value = btn.getAttribute('data-incident');
    });
  });

  // Atalhos de observação pedagógica
  document.querySelectorAll('[data-note]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-note');
      const textarea = document.getElementById('entry-pedagogical');
      textarea.value = textarea.value ? `${textarea.value}. ${val}` : val;
    });
  });

  // Fechar modais
  document.getElementById('btn-close-entry-modal').addEventListener('click', closeClassEntryModal);
  document.getElementById('btn-cancel-entry').addEventListener('click', closeClassEntryModal);
  document.getElementById('btn-close-history-modal').addEventListener('click', closeStudentHistoryModal);

  // Submissão de aula
  document.getElementById('form-class-entry').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btnSubmit = document.getElementById('btn-save-entry');
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span>⏳ Salvando...</span>';

    const timeInput = document.getElementById('entry-time');
    const classTime = timeInput ? timeInput.value : '';
    const editId = document.getElementById('entry-log-edit-id')?.value;
    let resourcesUsed = [];
    try {
      resourcesUsed = JSON.parse(document.getElementById('entry-resources-used')?.value || '[]');
    } catch (e) {
      resourcesUsed = [];
    }

    const payload = {
      student_id: parseInt(document.getElementById('entry-student-id').value),
      subject_id: parseInt(document.getElementById('entry-subject-id').value),
      classroom_id: document.getElementById('entry-classroom-id')?.value ? parseInt(document.getElementById('entry-classroom-id').value) : null,
      resources_used: resourcesUsed,
      class_date: document.getElementById('entry-date').value,
      class_time: classTime || undefined,
      status: state.currentEntryStatus,
      content: document.getElementById('entry-content').value,
      incidents: document.getElementById('entry-incidents').value,
      pedagogical_notes: document.getElementById('entry-pedagogical').value,
      teacher_name: state.currentUser ? state.currentUser.name : document.getElementById('entry-teacher').value
    };

    try {
      const url = editId ? `${API_BASE}/api/logs/${editId}` : `${API_BASE}/api/logs`;
      const method = editId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Erro ao salvar no PostgreSQL');
      }
      
      showToast(editId ? 'Diário atualizado com sucesso!' : 'Aula registrada com sucesso no sistema!');
      closeClassEntryModal();
      
      loadStudents();
      loadStats();
      if (state.activeView === 'view-history') {
        loadGeneralHistory();
      }
      if (state.activeView === 'view-teacher-today') {
        loadTeacherTodayClasses();
      }
      if (state.activeView === 'view-admin-dashboard') {
        loadAdminDashboardData();
      }

      // Se estiver no relatório daquele aluno, atualiza o relatório
      if (state.activeView === 'view-reports' && String(state.selectedReportStudentId) === String(payload.student_id)) {
        loadStudentReport(payload.student_id);
      }
    } catch (err) {
      showAppAlert(`Falha ao registrar aula: ${err.message}`, 'Lançamento de Aula');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<span>💾 Gravar Aula</span>';
    }
  });

  // Botões de Adicionar Aluno (rápido e no admin)
  document.getElementById('btn-add-student-quick').addEventListener('click', () => {
    openStudentModalAdmin(null);
  });
  document.getElementById('btn-add-student-admin').addEventListener('click', () => {
    openStudentModalAdmin(null);
  });
  document.getElementById('btn-close-student-modal').addEventListener('click', () => {
    document.getElementById('modal-student-admin').classList.add('hidden');
  });
  document.getElementById('btn-cancel-student').addEventListener('click', () => {
    document.getElementById('modal-student-admin').classList.add('hidden');
  });

  // Submissão do Aluno no Admin
  setupEnrollmentTabs();
  document.getElementById('form-student-admin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('student-edit-id').value;
    const checked = Array.from(document.querySelectorAll('input[name="admin_student_sub"]:checked')).map(cb => parseInt(cb.value));

    // Aluno inativo não tem grade: as abas de matrícula só são exigidas para aluno ativo
    const isActive = document.getElementById('student-status').value !== 'inativo';
    const collected = isActive ? collectEnrollments() : { enrollments: undefined };
    if (collected.error) {
      if (collected.subjectId) { enr.active = collected.subjectId; renderEnrollmentTabs(); }
      showAppAlert(collected.error, 'Matrícula');
      return;
    }

    const payload = {
      name: document.getElementById('student-name').value,
      objective_grade: document.getElementById('student-grade').value,
      start_date: document.getElementById('student-start-date').value,
      end_date: document.getElementById('student-end-date').value,
      status: document.getElementById('student-status').value,
      birth_date: document.getElementById('student-birth-date').value || null,
      address: document.getElementById('student-address').value,
      school_name: document.getElementById('student-school-name').value,
      school_contact_name: document.getElementById('student-school-contact').value,
      school_phone: document.getElementById('student-school-phone').value,
      enrollments: collected.enrollments,
      enrollment_notes: document.getElementById('student-enrollment-notes') ? document.getElementById('student-enrollment-notes').value : null,
      parent_name: document.getElementById('student-parent-name') ? document.getElementById('student-parent-name').value : undefined,
      parent_phone: document.getElementById('student-parent-phone') ? document.getElementById('student-parent-phone').value : undefined,
      parent_email: document.getElementById('student-parent-email') ? document.getElementById('student-parent-email').value : undefined,
      parent_access_code: document.getElementById('student-parent-code') ? document.getElementById('student-parent-code').value.trim().toUpperCase() : undefined,
      subject_ids: checked
    };

    const url = editId ? `${API_BASE}/api/students/${editId}` : `${API_BASE}/api/students`;
    const method = editId ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const d = await res.json();
        if (d.subject_id && enrCheckedSubjects().includes(String(d.subject_id))) {
          enr.active = String(d.subject_id);
          renderEnrollmentTabs();
        }
        throw new Error(d.error || 'Erro ao salvar aluno');
      }

      showToast(editId ? ' Aluno atualizado com sucesso!' : ' Novo aluno cadastrado!');
      document.getElementById('modal-student-admin').classList.add('hidden');
      loadAdminStudents();
      loadStudents();
      loadStats();
      loadSchedules();
      loadPendingStudents();
      populateReportStudentsDropdown();
    } catch (err) {
      showAppAlert(err.message, 'Cadastro de Aluno');
    }
  });

  // Botão de Adicionar Professor (Admin)
  document.getElementById('btn-add-teacher').addEventListener('click', () => {
    openTeacherModal(null);
  });
  document.getElementById('btn-close-teacher-modal').addEventListener('click', () => {
    document.getElementById('modal-teacher-admin').classList.add('hidden');
  });
  document.getElementById('btn-cancel-teacher').addEventListener('click', () => {
    document.getElementById('modal-teacher-admin').classList.add('hidden');
  });
  document.getElementById('btn-upload-teacher-doc').addEventListener('click', uploadTeacherDocument);

  // Submissão do Professor no Admin
  document.getElementById('form-teacher-admin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('teacher-edit-id').value;
    const checked = Array.from(document.querySelectorAll('input[name="teacher_sub"]:checked')).map(cb => parseInt(cb.value));

    const payload = {
      name: document.getElementById('teacher-name').value,
      email: document.getElementById('teacher-email').value,
      phone: document.getElementById('teacher-phone').value,
      password: document.getElementById('teacher-password').value || undefined,
      role: document.getElementById('teacher-role').value,
      status: document.getElementById('teacher-status').value,
      subject_ids: checked
    };

    const url = editId ? `${API_BASE}/api/teachers/${editId}` : `${API_BASE}/api/teachers`;
    const method = editId ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar professor');

      showToast(editId ? ' Professor atualizado com sucesso!' : ' Professor cadastrado com sucesso!');
      document.getElementById('modal-teacher-admin').classList.add('hidden');
      loadTeachers();
      loadStats();
    } catch (err) {
      showAppAlert(err.message, 'Cadastro de Professor');
    }
  });

  // ==========================================
  // EVENTOS DE MATÉRIAS (ADMIN)
  // ==========================================
  const btnAddSubjectAdmin = document.getElementById('btn-add-subject-admin');
  if (btnAddSubjectAdmin) {
    btnAddSubjectAdmin.addEventListener('click', () => openSubjectModalAdmin(null));
  }
  const btnCloseSubjectModal = document.getElementById('btn-close-subject-modal');
  if (btnCloseSubjectModal) {
    btnCloseSubjectModal.addEventListener('click', closeSubjectModalAdmin);
  }
  const btnCancelSubject = document.getElementById('btn-cancel-subject');
  if (btnCancelSubject) {
    btnCancelSubject.addEventListener('click', closeSubjectModalAdmin);
  }

  const inputAdminSubjectSearch = document.getElementById('input-admin-subject-search');
  if (inputAdminSubjectSearch) {
    inputAdminSubjectSearch.addEventListener('input', (e) => {
      state.adminSubjectSearch = e.target.value;
      renderAdminSubjectsList();
    });
  }

  const formSubjectAdmin = document.getElementById('form-subject-admin');
  if (formSubjectAdmin) {
    formSubjectAdmin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const editId = document.getElementById('subject-edit-id').value;
      const name = document.getElementById('subject-name').value.trim();
      const code = document.getElementById('subject-code').value.trim();
      const classroom_id = document.getElementById('subject-classroom-id')?.value ? parseInt(document.getElementById('subject-classroom-id').value) : null;
      const max_students = document.getElementById('subject-max-students')?.value ? parseInt(document.getElementById('subject-max-students').value) : null;
      const total_lessons = document.getElementById('subject-total-lessons')?.value ? parseInt(document.getElementById('subject-total-lessons').value) : null;
      const reqResStr = document.getElementById('subject-required-resources')?.value.trim();
      const required_resources = reqResStr ? reqResStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      if (!name) {
        showAppAlert('O nome da matéria é obrigatório.', 'Cadastro de Matéria');
        return;
      }

      const payload = { 
        name, 
        code, 
        classroom_id, 
        max_students, 
        total_lessons, 
        required_resources 
      };
      const url = editId ? `${API_BASE}/api/subjects/${editId}` : `${API_BASE}/api/subjects`;
      const method = editId ? 'PUT' : 'POST';

      try {
        const res = await fetch(url, {
          method,
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha ao salvar matéria');

        showToast(editId ? 'Matéria atualizada com sucesso!' : 'Matéria cadastrada com sucesso!');
        closeSubjectModalAdmin();
        await loadSubjects();
        loadAdminSubjects();
        loadStudents();
      } catch (err) {
        showAppAlert(err.message, 'Erro na Matéria');
      }
    });
  }

  // Listeners de Salas & Recursos no Admin
  const searchClassroom = document.getElementById('input-admin-classroom-search');
  if (searchClassroom) {
    searchClassroom.addEventListener('input', (e) => {
      state.adminClassroomSearch = e.target.value;
      renderClassroomsList();
    });
  }

  const btnAddClassroom = document.getElementById('btn-add-classroom-admin');
  if (btnAddClassroom) {
    btnAddClassroom.addEventListener('click', () => openClassroomModalAdmin(null));
  }

  document.getElementById('btn-close-classroom-modal')?.addEventListener('click', closeClassroomModalAdmin);
  document.getElementById('btn-cancel-classroom')?.addEventListener('click', closeClassroomModalAdmin);

  const formClassroomAdmin = document.getElementById('form-classroom-admin');
  if (formClassroomAdmin) {
    formClassroomAdmin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const editId = document.getElementById('classroom-edit-id').value;
      const name = document.getElementById('classroom-name').value.trim();
      const type = document.getElementById('classroom-type').value;
      const capacity_students = parseInt(document.getElementById('classroom-capacity-students').value) || 4;
      const capacity_teachers = parseInt(document.getElementById('classroom-capacity-teachers').value) || 1;
      const description = document.getElementById('classroom-description').value.trim();

      const checkboxes = formClassroomAdmin.querySelectorAll('input[name="classroom_res"]:checked');
      const resources = Array.from(checkboxes).map(cb => cb.value);
      const customStr = document.getElementById('classroom-custom-resources').value.trim();
      if (customStr) {
        customStr.split(',').map(s => s.trim()).filter(Boolean).forEach(r => {
          if (!resources.includes(r)) resources.push(r);
        });
      }

      const payload = {
        name,
        type,
        capacity_students,
        capacity_teachers,
        resources,
        description
      };

      const url = editId ? `${API_BASE}/api/classrooms/${editId}` : `${API_BASE}/api/classrooms`;
      const method = editId ? 'PUT' : 'POST';

      try {
        const res = await fetch(url, {
          method,
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha ao salvar sala');

        showToast(editId ? 'Sala atualizada com sucesso!' : 'Sala cadastrada com sucesso!');
        closeClassroomModalAdmin();
        await loadClassrooms();
      } catch (err) {
        showAppAlert(err.message, 'Erro na Sala');
      }
    });
  }

  // =========================================================
  // EVENTOS DA GRADE DE HORÁRIOS ESTILO GOOGLE CALENDAR
  // =========================================================
  const btnGcalToday = document.getElementById('btn-gcal-today');
  if (btnGcalToday) btnGcalToday.addEventListener('click', goToCalendarToday);

  const btnGcalPrev = document.getElementById('btn-gcal-prev');
  if (btnGcalPrev) btnGcalPrev.addEventListener('click', () => navigateCalendar(-1));

  const btnGcalNext = document.getElementById('btn-gcal-next');
  if (btnGcalNext) btnGcalNext.addEventListener('click', () => navigateCalendar(1));

  document.querySelectorAll('.btn-gcal-view').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      setCalendarView(view);
    });
  });

  const schedTeacherFilter = document.getElementById('select-filter-schedule-teacher');
  if (schedTeacherFilter) {
    schedTeacherFilter.addEventListener('change', (e) => {
      state.selectedScheduleTeacherId = e.target.value;
      renderGoogleCalendar();
    });
  }

  const schedStudentFilter = document.getElementById('select-filter-schedule-student');
  if (schedStudentFilter) {
    schedStudentFilter.addEventListener('change', (e) => {
      state.selectedScheduleStudentId = e.target.value;
      renderGoogleCalendar();
    });
  }

  const schedFreqFilter = document.getElementById('select-filter-schedule-frequency');
  if (schedFreqFilter) {
    schedFreqFilter.addEventListener('change', (e) => {
      state.selectedScheduleFrequency = e.target.value;
      renderGoogleCalendar();
    });
  }

  // Botão e Modal de Alunos Aguardando Professor / Matrícula
  const btnPendingEnrollments = document.getElementById('btn-pending-enrollments');
  if (btnPendingEnrollments) {
    btnPendingEnrollments.addEventListener('click', openBindTeacherModal);
  }

  const btnCloseBindModal = document.getElementById('btn-close-bind-modal');
  if (btnCloseBindModal) {
    btnCloseBindModal.addEventListener('click', closeBindTeacherModal);
  }

  const btnCancelBindSelection = document.getElementById('btn-cancel-bind-selection');
  if (btnCancelBindSelection) {
    btnCancelBindSelection.addEventListener('click', () => {
      const card = document.getElementById('bind-action-card');
      if (card) card.classList.add('hidden');
    });
  }

  const bindFreqSelect = document.getElementById('bind-frequency-type');
  const bindGroupCustomDays = document.getElementById('bind-group-custom-days');
  if (bindFreqSelect && bindGroupCustomDays) {
    bindFreqSelect.addEventListener('change', () => {
      if (bindFreqSelect.value === 'custom_dias') {
        bindGroupCustomDays.classList.remove('hidden');
      } else {
        bindGroupCustomDays.classList.add('hidden');
      }
    });
  }

  const formBindTeacherAction = document.getElementById('form-bind-teacher-action');
  if (formBindTeacherAction) {
    formBindTeacherAction.addEventListener('submit', handleBindTeacherSubmit);
  }

  // Modal de Detalhe do Evento
  const btnCloseEventDetail = document.getElementById('btn-close-event-detail');
  if (btnCloseEventDetail) {
    btnCloseEventDetail.addEventListener('click', closeEventDetailModal);
  }

  const btnEventQuickLog = document.getElementById('btn-event-quick-log');
  if (btnEventQuickLog) {
    btnEventQuickLog.addEventListener('click', () => {
      if (state.selectedEventForDetail) {
        const ev = state.selectedEventForDetail.event;
        const dt = state.selectedEventForDetail.dateStr;
        closeEventDetailModal();
        openClassEntryModal(ev.student_id, ev.subject_id, dt);
      }
    });
  }

  const btnEventEditSched = document.getElementById('btn-event-edit-sched');
  if (btnEventEditSched) {
    btnEventEditSched.addEventListener('click', () => {
      if (state.selectedEventForDetail) {
        const schedId = state.selectedEventForDetail.event.id;
        closeEventDetailModal();
        openScheduleModal(schedId);
      }
    });
  }

  // Modal de Cadastro/Edição de Horário
  const btnAddSched = document.getElementById('btn-add-schedule');
  if (btnAddSched) {
    btnAddSched.addEventListener('click', () => openScheduleModal(null));
  }

  const btnCloseSched = document.getElementById('btn-close-schedule-modal');
  if (btnCloseSched) btnCloseSched.addEventListener('click', closeScheduleModal);
  const btnCancelSched = document.getElementById('btn-cancel-schedule');
  if (btnCancelSched) btnCancelSched.addEventListener('click', closeScheduleModal);

  const schedModalFreq = document.getElementById('sched-frequency-type');
  const schedCustomIntervalGroup = document.getElementById('group-sched-custom-interval');
  if (schedModalFreq && schedCustomIntervalGroup) {
    schedModalFreq.addEventListener('change', () => {
      if (schedModalFreq.value === 'custom_dias') {
        schedCustomIntervalGroup.classList.remove('hidden');
      } else {
        schedCustomIntervalGroup.classList.add('hidden');
      }
    });
  }

  document.querySelectorAll('.chip-room').forEach(btn => {
    btn.addEventListener('click', () => {
      const room = btn.getAttribute('data-room');
      const input = document.getElementById('sched-room');
      if (input) input.value = room;
    });
  });

  const formSched = document.getElementById('form-schedule-admin');
  if (formSched) {
    formSched.addEventListener('submit', async (e) => {
      e.preventDefault();
      const editId = document.getElementById('schedule-edit-id').value;
      const freq = document.getElementById('sched-frequency-type').value;
      const intervalVal = document.getElementById('sched-custom-interval') ? parseInt(document.getElementById('sched-custom-interval').value) : (freq === 'quinzenal' ? 14 : 7);

      const roomId = document.getElementById('sched-classroom-id')?.value;
      const selectedRoom = (state.classrooms || []).find(r => String(r.id) === String(roomId));

      const payload = {
        teacher_id: parseInt(document.getElementById('sched-teacher-id').value),
        student_id: document.getElementById('sched-student-id').value ? parseInt(document.getElementById('sched-student-id').value) : null,
        subject_id: document.getElementById('sched-subject-id').value ? parseInt(document.getElementById('sched-subject-id').value) : null,
        classroom_id: roomId ? parseInt(roomId) : null,
        day_of_week: parseInt(document.getElementById('sched-day-of-week').value),
        frequency_type: freq,
        recurrence_interval_days: intervalVal,
        start_time: document.getElementById('sched-start-time').value,
        end_time: document.getElementById('sched-end-time').value,
        room_or_info: selectedRoom ? selectedRoom.name : (document.getElementById('sched-room')?.value || 'Sala Presencial / Online'),
        notes: document.getElementById('sched-notes').value
      };

      const url = editId ? `${API_BASE}/api/schedules/${editId}` : `${API_BASE}/api/schedules`;
      const method = editId ? 'PUT' : 'POST';

      try {
        const res = await fetch(url, {
          method,
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar horário');

        showToast(editId ? ' Horário atualizado com sucesso!' : ' Novo horário cadastrado com sucesso!');
        closeScheduleModal();
        await loadSchedules();
        await loadPendingStudents();
      } catch (err) {
        showAppAlert(err.message, 'Erro ao Salvar Horário');
      }
    });
  }
}

// =========================================================
// MOTOR DA GRADE DE HORÁRIOS ESTILO GOOGLE CALENDAR
// =========================================================

async function loadSchedules() {
  try {
    const res = await fetch(`${API_BASE}/api/schedules`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Erro ao carregar grade de horários');
    state.schedules = await res.json();

    populateCalendarFilters();
    renderGoogleCalendar();
    loadPendingStudents();
  } catch (err) {
    console.error('Erro ao buscar horários:', err);
  }
}

async function loadPendingStudents() {
  // Fila de matrículas é exclusiva da coordenação
  if (!state.currentUser || state.currentUser.role !== 'admin') {
    state.pendingStudents = [];
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/students-pending-teacher`, { headers: getAuthHeaders() });
    if (res.ok) {
      state.pendingStudents = await res.json();
    } else {
      // Fallback local se a rota não responder
      state.pendingStudents = (state.students || []).filter(s => s.enrollment_status === 'aguardando_professor' || !s.assigned_teacher_id);
    }

    const countEl = document.getElementById('pending-students-count');
    if (countEl) countEl.textContent = state.pendingStudents.length;

    const listCountEl = document.getElementById('pending-students-list-count');
    if (listCountEl) listCountEl.textContent = state.pendingStudents.length;
  } catch (err) {
    console.error('Erro ao buscar alunos pendentes:', err);
  }
}

function populateCalendarFilters() {
  // 1. Professores
  const teacherSelect = document.getElementById('select-filter-schedule-teacher');
  if (teacherSelect) {
    const currentVal = state.selectedScheduleTeacherId;
    const teacherMap = new Map();

    state.schedules.forEach(s => {
      if (s.teacher_id && s.teacher_name) teacherMap.set(String(s.teacher_id), s.teacher_name);
    });
    (state.teachers || []).filter(t => t.role === 'professor').forEach(t => teacherMap.set(String(t.id), t.name));

    let html = '<option value="">👨‍🏫 Todos os Professores</option>';
    teacherMap.forEach((name, id) => {
      const isSel = String(id) === String(currentVal) ? 'selected' : '';
      html += `<option value="${id}" ${isSel}>Prof. ${name}</option>`;
    });
    teacherSelect.innerHTML = html;
  }

  // 2. Alunos
  const studentSelect = document.getElementById('select-filter-schedule-student');
  if (studentSelect) {
    const currentVal = state.selectedScheduleStudentId;
    const studentMap = new Map();

    state.schedules.forEach(s => {
      if (s.student_id && s.student_name) studentMap.set(String(s.student_id), s.student_name);
    });
    (state.students || []).forEach(st => studentMap.set(String(st.id), st.name));

    let html = '<option value="">🎓 Todos os Alunos</option>';
    studentMap.forEach((name, id) => {
      const isSel = String(id) === String(currentVal) ? 'selected' : '';
      html += `<option value="${id}" ${isSel}>${name}</option>`;
    });
    studentSelect.innerHTML = html;
  }
}

function goToCalendarToday() {
  state.calendarCurrentDate = new Date();
  renderGoogleCalendar();
}

function navigateCalendar(direction) {
  const cur = new Date(state.calendarCurrentDate);

  if (state.calendarView === 'month') {
    cur.setMonth(cur.getMonth() + direction);
  } else if (state.calendarView === 'week') {
    cur.setDate(cur.getDate() + (direction * 7));
  } else if (state.calendarView === 'day') {
    cur.setDate(cur.getDate() + direction);
  } else if (state.calendarView === 'year') {
    cur.setFullYear(cur.getFullYear() + direction);
  }

  state.calendarCurrentDate = cur;
  renderGoogleCalendar();
}

function setCalendarView(viewName) {
  state.calendarView = viewName;

  // Atualiza botões
  document.querySelectorAll('.btn-gcal-view').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === viewName);
  });

  // Atualiza painéis
  const panes = {
    month: document.getElementById('gcal-month-view'),
    week: document.getElementById('gcal-week-view'),
    day: document.getElementById('gcal-day-view'),
    year: document.getElementById('gcal-year-view')
  };

  Object.entries(panes).forEach(([k, el]) => {
    if (!el) return;
    if (k === viewName) {
      el.classList.remove('hidden');
      el.classList.add('active');
    } else {
      el.classList.add('hidden');
      el.classList.remove('active');
    }
  });

  renderGoogleCalendar();
}

function renderGoogleCalendar() {
  const date = state.calendarCurrentDate;
  const labelEl = document.getElementById('gcal-current-label');
  const todayBadge = document.getElementById('gcal-today-badge');

  const monthNames = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];
  const dayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

  // Atualiza badge de hoje
  if (todayBadge) {
    const now = new Date();
    const dStr = String(now.getDate()).padStart(2, '0');
    const mStr = String(now.getMonth() + 1).padStart(2, '0');
    todayBadge.textContent = `Hoje: ${dStr}/${mStr}/${now.getFullYear()}`;
  }

  // Atualiza título do período conforme a visão ativa
  if (labelEl) {
    if (state.calendarView === 'month') {
      labelEl.textContent = `${monthNames[date.getMonth()]} de ${date.getFullYear()}`;
    } else if (state.calendarView === 'year') {
      labelEl.textContent = `Ano de ${date.getFullYear()}`;
    } else if (state.calendarView === 'day') {
      const dStr = String(date.getDate()).padStart(2, '0');
      labelEl.textContent = `${dayNames[date.getDay()]}, ${dStr} de ${monthNames[date.getMonth()]}`;
    } else if (state.calendarView === 'week') {
      const sunday = new Date(date);
      sunday.setDate(date.getDate() - date.getDay());
      const saturday = new Date(sunday);
      saturday.setDate(sunday.getDate() + 6);

      const d1 = String(sunday.getDate()).padStart(2, '0');
      const d2 = String(saturday.getDate()).padStart(2, '0');
      const m1 = monthNames[sunday.getMonth()].substring(0, 3);
      const m2 = monthNames[saturday.getMonth()].substring(0, 3);

      labelEl.textContent = `${d1} de ${m1} – ${d2} de ${m2} de ${saturday.getFullYear()}`;
    }
  }

  // Permissões de edição no cabeçalho
  const isAdmin = state.currentUser && state.currentUser.role === 'admin';
  const btnAddSched = document.getElementById('btn-add-schedule');
  const badgeReadonly = document.getElementById('badge-teacher-readonly');
  if (btnAddSched) btnAddSched.classList.toggle('hidden', !isAdmin);
  if (badgeReadonly) badgeReadonly.classList.toggle('hidden', isAdmin);

  // Renderiza a visão específica
  if (state.calendarView === 'month') renderMonthView();
  else if (state.calendarView === 'week') renderWeekView();
  else if (state.calendarView === 'day') renderDayView();
  else if (state.calendarView === 'year') renderYearView();
}

// Converte Date/'YYYY-MM-DD...'/'DD/MM/YYYY' em 'YYYY-MM-DD' (ou null)
function toIsoDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const br = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return br ? `${br[3]}-${br[2]}-${br[1]}` : null;
}

function isoDateToUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Verifica se um agendamento recorrente ocorre em uma data específica.
 * Mesma regra do backend (isScheduleOnDate em server.js):
 * - semanal: toda semana no dia configurado
 * - quinzenal: semana sim, semana não, a partir da 1ª ocorrência desde a data de início
 * - custom_dias: a cada N dias, a partir da 1ª ocorrência desde a data de início
 */
function isScheduleActiveOnDate(sched, dateObj) {
  const target = toIsoDateOnly(dateObj);
  const start = toIsoDateOnly(sched.start_date) || toIsoDateOnly(sched.student_start_date) || toIsoDateOnly(sched.created_at);
  const end = toIsoDateOnly(sched.end_date);
  if (start && target < start) return false;
  if (end && target > end) return false;

  const freq = sched.resolved_frequency || sched.frequency_type || 'semanal';
  const base = start || target;
  const baseDow = new Date(isoDateToUTC(base)).getUTCDay();
  const shift = (Number(sched.day_of_week) - baseDow + 7) % 7;
  const anchorUTC = isoDateToUTC(base) + shift * 86400000;
  const diffDays = Math.round((isoDateToUTC(target) - anchorUTC) / 86400000);

  if (freq === 'custom_dias') {
    const interval = parseInt(sched.resolved_interval_days || sched.recurrence_interval_days || sched.custom_interval_days) || 3;
    return diffDays >= 0 && diffDays % interval === 0;
  }

  if (dateObj.getDay() !== Number(sched.day_of_week)) return false;
  if (freq === 'quinzenal') return diffDays >= 0 && (diffDays / 7) % 2 === 0;
  return true;
}

function getFilteredSchedulesForDate(dateObj) {
  let list = [...(state.schedules || [])];

  if (state.selectedScheduleTeacherId) {
    list = list.filter(s => String(s.teacher_id) === String(state.selectedScheduleTeacherId));
  }
  if (state.selectedScheduleStudentId) {
    list = list.filter(s => String(s.student_id) === String(state.selectedScheduleStudentId));
  }
  if (state.selectedScheduleFrequency) {
    list = list.filter(s => {
      const f = s.resolved_frequency || s.frequency_type || 'semanal';
      return f === state.selectedScheduleFrequency;
    });
  }

  return list.filter(s => isScheduleActiveOnDate(s, dateObj)).sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
}

function getEventColorTheme(sched) {
  const code = (sched.subject_code || sched.subject_name || '').toLowerCase();
  if (code.includes('port') || code.includes('redac')) return 'event-theme-orange';
  if (code.includes('mat') || code.includes('fis') || code.includes('exat')) return 'event-theme-navy';
  if (code.includes('ing') || code.includes('idiom') || code.includes('espanhol')) return 'event-theme-blue';
  return 'event-theme-teal';
}

// ---------------------------------------------------------
// 1. RENDERIZADOR: VISÃO MENSAL (GOOGLE CALENDAR MONTH)
// ---------------------------------------------------------
function renderMonthView() {
  const grid = document.getElementById('gcal-month-grid');
  if (!grid) return;

  const cur = state.calendarCurrentDate;
  const year = cur.getFullYear();
  const month = cur.getMonth();

  const firstDayOfMonth = new Date(year, month, 1);
  const startDayOfWeek = firstDayOfMonth.getDay(); // 0=Dom, 1=Seg, ...
  const daysInCurrentMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const today = new Date();
  const isSameMonthAndYear = (today.getFullYear() === year && today.getMonth() === month);

  let html = '';

  // 1. Dias do mês anterior para completar o início da grade
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const dayNum = daysInPrevMonth - i;
    const prevDate = new Date(year, month - 1, dayNum);
    const events = getFilteredSchedulesForDate(prevDate);
    html += renderMonthCell(dayNum, events, prevDate, true, false);
  }

  // 2. Dias do mês atual
  for (let dayNum = 1; dayNum <= daysInCurrentMonth; dayNum++) {
    const thisDate = new Date(year, month, dayNum);
    const isToday = isSameMonthAndYear && today.getDate() === dayNum;
    const events = getFilteredSchedulesForDate(thisDate);
    html += renderMonthCell(dayNum, events, thisDate, false, isToday);
  }

  // 3. Dias do mês seguinte para completar o grid (42 células = 6 semanas)
  const totalRendered = startDayOfWeek + daysInCurrentMonth;
  const trailingDays = (totalRendered % 7 === 0) ? 0 : (7 - (totalRendered % 7));
  for (let dayNum = 1; dayNum <= trailingDays; dayNum++) {
    const nextDate = new Date(year, month + 1, dayNum);
    const events = getFilteredSchedulesForDate(nextDate);
    html += renderMonthCell(dayNum, events, nextDate, true, false);
  }

  grid.innerHTML = html;

  // Listeners nos eventos do mês
  grid.querySelectorAll('.gcal-event-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const schedId = pill.getAttribute('data-sched-id');
      const dateStr = pill.getAttribute('data-date');
      const s = state.schedules.find(item => String(item.id) === String(schedId));
      if (s) openEventDetailModal(s, dateStr);
    });
  });

  // Clicar em "+N mais" ou no dia abre a Visão Diária
  grid.querySelectorAll('.gcal-more-btn, .gcal-cell-day-num').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const dStr = el.getAttribute('data-date');
      if (dStr) {
        state.calendarCurrentDate = new Date(dStr);
        setCalendarView('day');
      }
    });
  });
}

function renderMonthCell(dayNum, events, dateObj, isOtherMonth, isToday) {
  const dateIso = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
  const cellClasses = ['gcal-month-cell'];
  if (isOtherMonth) cellClasses.push('other-month');
  if (isToday) cellClasses.push('is-today');

  const maxDisplay = 3;
  const visibleEvents = events.slice(0, maxDisplay);
  const overflowCount = events.length - maxDisplay;

  return `
    <div class="${cellClasses.join(' ')}">
      <div class="gcal-cell-header">
        <span class="gcal-cell-day-num" data-date="${dateIso}">${dayNum}</span>
      </div>
      <div class="gcal-events-stack">
        ${visibleEvents.map(s => {
          const theme = getEventColorTheme(s);
          const studentDisplay = s.student_name ? s.student_name.split(' ')[0] : (s.teacher_name || 'Aula');
          const freqLabel = s.resolved_frequency === 'quinzenal' ? '15d' : (s.resolved_frequency === 'custom_dias' ? `${s.resolved_interval_days}d` : '');
          return `
            <div class="gcal-event-pill ${theme}" data-sched-id="${s.id}" data-date="${dateIso}" title="${s.start_time} - ${s.subject_name || 'Aula'} (${s.teacher_name})">
              <span class="gcal-event-time">${s.start_time}</span>
              <span class="gcal-event-text">${studentDisplay}</span>
              ${freqLabel ? `<span class="gcal-event-freq-badge">${freqLabel}</span>` : ''}
            </div>
          `;
        }).join('')}
        ${overflowCount > 0 ? `
          <button type="button" class="gcal-more-btn" data-date="${dateIso}">
            +${overflowCount} mais
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------
// 2. RENDERIZADOR: VISÃO SEMANAL (GOOGLE CALENDAR WEEK)
// ---------------------------------------------------------
function renderWeekView() {
  const container = document.getElementById('gcal-week-container');
  if (!container) return;

  const cur = state.calendarCurrentDate;
  const sunday = new Date(cur);
  sunday.setDate(cur.getDate() - cur.getDay());

  const daysOfWeek = [];
  const dayNamesShort = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    const isToday = (today.getFullYear() === d.getFullYear() && today.getMonth() === d.getMonth() && today.getDate() === d.getDate());
    daysOfWeek.push({
      date: d,
      name: dayNamesShort[i],
      num: d.getDate(),
      isToday,
      iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      events: getFilteredSchedulesForDate(d)
    });
  }

  // Linhas de horário: 07:00 às 20:00
  const hours = [];
  for (let h = 7; h <= 20; h++) {
    hours.push(`${String(h).padStart(2, '0')}:00`);
  }

  let html = `
    <table class="gcal-week-table">
      <thead>
        <tr>
          <th class="gcal-week-time-col">Horário</th>
          ${daysOfWeek.map(d => `
            <th>
              <div class="gcal-week-header-day">
                <span class="gcal-week-day-title">${d.name}</span>
                <span class="gcal-week-day-num ${d.isToday ? 'is-today' : ''}">${d.num}</span>
              </div>
            </th>
          `).join('')}
        </tr>
      </thead>
      <tbody>
        ${hours.map(hour => {
          const hourNum = parseInt(hour.split(':')[0]);
          return `
            <tr>
              <td class="gcal-week-time-col">${hour}</td>
              ${daysOfWeek.map(d => {
                const hourEvents = d.events.filter(s => {
                  const sHour = parseInt((s.start_time || '00:00').split(':')[0]);
                  return sHour === hourNum;
                });

                return `
                  <td>
                    <div class="gcal-week-slot">
                      ${hourEvents.map(s => {
                        const theme = getEventColorTheme(s);
                        return `
                          <div class="gcal-week-card ${theme}" data-sched-id="${s.id}" data-date="${d.iso}">
                            <div style="font-weight: 800; font-size: 0.72rem; color: var(--brand-blue);">
                              🕒 ${s.start_time} - ${s.end_time}
                            </div>
                            <div style="font-weight: 700; color: var(--text-main);">
                              ${s.subject_name || 'Aula Geral'}
                            </div>
                            <div style="font-size: 0.68rem; color: var(--text-muted);">
                              🎓 ${s.student_name || 'Aluno'} • 👨‍🏫 ${s.teacher_name}
                            </div>
                          </div>
                        `;
                      }).join('')}
                    </div>
                  </td>
                `;
              }).join('')}
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = html;

  container.querySelectorAll('.gcal-week-card').forEach(card => {
    card.addEventListener('click', () => {
      const schedId = card.getAttribute('data-sched-id');
      const dateStr = card.getAttribute('data-date');
      const s = state.schedules.find(item => String(item.id) === String(schedId));
      if (s) openEventDetailModal(s, dateStr);
    });
  });
}

// ---------------------------------------------------------
// 3. RENDERIZADOR: VISÃO DIÁRIA (GOOGLE CALENDAR DAY VIEW)
// ---------------------------------------------------------
function renderDayView() {
  const container = document.getElementById('gcal-day-container');
  if (!container) return;

  const targetDate = state.calendarCurrentDate;
  const events = getFilteredSchedulesForDate(targetDate);
  const dateIso = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;

  if (events.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 50px 20px; color: var(--text-muted);">
        <div style="font-size: 3rem; margin-bottom: 10px;">☕</div>
        <h3 style="color: var(--brand-blue); margin-bottom: 6px;">Nenhuma aula agendada para este dia</h3>
        <p class="text-sm">Não há compromissos previstos na grade para a data selecionada.</p>
        ${state.currentUser && state.currentUser.role === 'admin' ? `
          <button onclick="openScheduleModal(null)" class="btn-primary-action" style="margin-top: 16px;">
            <span>➕ Agendar Aula Neste Dia</span>
          </button>
        ` : ''}
      </div>
    `;
    return;
  }

  // Agrupa eventos por hora
  const hoursMap = {};
  for (let h = 7; h <= 21; h++) {
    const hStr = `${String(h).padStart(2, '0')}:00`;
    hoursMap[hStr] = [];
  }

  events.forEach(s => {
    const hNum = parseInt((s.start_time || '08:00').split(':')[0]);
    const key = `${String(hNum).padStart(2, '0')}:00`;
    if (!hoursMap[key]) hoursMap[key] = [];
    hoursMap[key].push(s);
  });

  let html = '';
  Object.entries(hoursMap).forEach(([hourStr, list]) => {
    if (list.length === 0) return;

    html += `
      <div class="gcal-day-timeline-row">
        <div class="gcal-day-hour-col">${hourStr}</div>
        <div class="gcal-day-events-col">
          ${list.map(s => {
            const freqLabel = s.resolved_frequency === 'quinzenal' 
              ? '🌓 Quinzenal' 
              : (s.resolved_frequency === 'custom_dias' ? `⚙️ A cada ${s.resolved_interval_days} dias` : '📅 Semanal');

            return `
              <div class="gcal-day-card" data-sched-id="${s.id}" data-date="${dateIso}">
                <div class="gcal-day-card-left">
                  <span class="gcal-day-card-icon">📖</span>
                  <div>
                    <div class="gcal-day-card-subject">${s.subject_name || 'Matéria Geral'}</div>
                    <div class="gcal-day-card-meta">
                      <span>🕒 <strong>${s.start_time} - ${s.end_time}</strong></span>
                      <span>👨‍🏫 Prof. ${s.teacher_name}</span>
                      <span>🎓 Aluno: <strong>${s.student_name || 'Livre'}</strong></span>
                      <span class="legend-tag tag-semanal">${freqLabel}</span>
                    </div>
                  </div>
                </div>

                <div class="gcal-day-card-right">
                  <button type="button" class="btn-card-action primary btn-quick-log-card" data-sched-id="${s.id}" data-date="${dateIso}">
                    <span>✍️ Diário</span>
                  </button>
                  <button type="button" class="btn-card-action secondary btn-quick-detail-card" data-sched-id="${s.id}" data-date="${dateIso}">
                    <span>👁️ Detalhes</span>
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll('.btn-quick-log-card').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const schedId = btn.getAttribute('data-sched-id');
      const dt = btn.getAttribute('data-date');
      const s = state.schedules.find(item => String(item.id) === String(schedId));
      if (s) openClassEntryModal(s.student_id, s.subject_id, dt);
    });
  });

  container.querySelectorAll('.btn-quick-detail-card, .gcal-day-card').forEach(el => {
    el.addEventListener('click', () => {
      const schedId = el.getAttribute('data-sched-id');
      const dt = el.getAttribute('data-date');
      const s = state.schedules.find(item => String(item.id) === String(schedId));
      if (s) openEventDetailModal(s, dt);
    });
  });
}

// ---------------------------------------------------------
// 4. RENDERIZADOR: VISÃO ANUAL (12 MINI-MESES)
// ---------------------------------------------------------
function renderYearView() {
  const container = document.getElementById('gcal-year-container');
  if (!container) return;

  const currentYear = state.calendarCurrentDate.getFullYear();
  const monthNames = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];
  const today = new Date();

  let html = '';
  for (let m = 0; m < 12; m++) {
    const firstDay = new Date(currentYear, m, 1);
    const startDow = firstDay.getDay();
    const daysInMonth = new Date(currentYear, m + 1, 0).getDate();

    html += `
      <div class="gcal-mini-month-card">
        <h4 class="gcal-mini-month-title" data-year="${currentYear}" data-month="${m}">
          ${monthNames[m]} ${currentYear}
        </h4>
        <table class="gcal-mini-table">
          <thead>
            <tr>
              <th>D</th><th>S</th><th>T</th><th>Q</th><th>Q</th><th>S</th><th>S</th>
            </tr>
          </thead>
          <tbody>
            <tr>
    `;

    // Células vazias iniciais
    for (let blank = 0; blank < startDow; blank++) {
      html += `<td></td>`;
    }

    let dowCol = startDow;
    for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
      if (dowCol === 7) {
        html += `</tr><tr>`;
        dowCol = 0;
      }

      const dObj = new Date(currentYear, m, dayNum);
      const isToday = (today.getFullYear() === currentYear && today.getMonth() === m && today.getDate() === dayNum);
      const hasClass = getFilteredSchedulesForDate(dObj).length > 0;
      const dIso = `${currentYear}-${String(m + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;

      let cls = 'gcal-mini-day';
      if (isToday) cls += ' is-today';
      if (hasClass) cls += ' has-class';

      html += `
        <td>
          <div class="${cls}" data-date="${dIso}" title="${hasClass ? 'Possui aulas agendadas' : ''}">
            ${dayNum}
          </div>
        </td>
      `;
      dowCol++;
    }

    // Completa última linha
    while (dowCol < 7 && dowCol > 0) {
      html += `<td></td>`;
      dowCol++;
    }

    html += `
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }

  container.innerHTML = html;

  // Clicar no título do mês abre a Visão Mensal daquele mês
  container.querySelectorAll('.gcal-mini-month-title').forEach(t => {
    t.addEventListener('click', () => {
      const y = parseInt(t.getAttribute('data-year'));
      const m = parseInt(t.getAttribute('data-month'));
      state.calendarCurrentDate = new Date(y, m, 1);
      setCalendarView('month');
    });
  });

  // Clicar em qualquer dia do mini calendário abre a Visão Diária daquele dia
  container.querySelectorAll('.gcal-mini-day').forEach(d => {
    d.addEventListener('click', () => {
      const dStr = d.getAttribute('data-date');
      if (dStr) {
        state.calendarCurrentDate = new Date(dStr + 'T12:00:00');
        setCalendarView('day');
      }
    });
  });
}

// ---------------------------------------------------------
// MODAL: DETALHES DO EVENTO DE AULA
// ---------------------------------------------------------
function openEventDetailModal(schedItem, dateStr) {
  state.selectedEventForDetail = { event: schedItem, dateStr };

  const modal = document.getElementById('modal-schedule-event-detail');
  if (!modal) return;

  const subjectPill = document.getElementById('event-detail-subject-pill');
  const titleEl = document.getElementById('event-detail-title');
  const dateTimeEl = document.getElementById('event-detail-date-time');
  const freqEl = document.getElementById('event-detail-frequency');
  const teacherEl = document.getElementById('event-detail-teacher');
  const studentEl = document.getElementById('event-detail-student');
  const roomEl = document.getElementById('event-detail-room');
  const parentEl = document.getElementById('event-detail-parent');
  const notesEl = document.getElementById('event-detail-notes');

  if (subjectPill) subjectPill.textContent = schedItem.subject_name || 'Geral';
  if (titleEl) titleEl.textContent = `Aula: ${schedItem.subject_name || 'Sem Matéria'}`;

  // Formata data e horário
  let dateFormatted = dateStr;
  if (dateStr) {
    const parts = dateStr.split('-');
    if (parts.length === 3) dateFormatted = `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  if (dateTimeEl) dateTimeEl.textContent = `${schedItem.day_name || 'Dia'}, ${dateFormatted || ''} (${schedItem.start_time} - ${schedItem.end_time})`;

  const freq = schedItem.resolved_frequency || schedItem.frequency_type || 'semanal';
  if (freqEl) {
    if (freq === 'quinzenal') freqEl.textContent = '🌓 Recorrência Quinzenal (A cada 15 dias)';
    else if (freq === 'custom_dias') freqEl.textContent = `⚙️ Recorrência a cada ${schedItem.resolved_interval_days || 3} dias`;
    else freqEl.textContent = '📅 Recorrência Semanal (Toda semana)';
  }

  if (teacherEl) teacherEl.textContent = `Prof. ${schedItem.teacher_name || 'Não informado'}`;
  if (studentEl) studentEl.textContent = schedItem.student_name ? `${schedItem.student_name} (${schedItem.student_objective_grade || 'Matriculado'})` : 'Horário Livre';
  if (roomEl) roomEl.textContent = schedItem.room_or_info || 'Sala Presencial 01';

  if (parentEl) {
    if (schedItem.student_parent_name) {
      parentEl.textContent = `${schedItem.student_parent_name} • ${schedItem.student_parent_phone || 'Sem telefone'}`;
    } else {
      parentEl.textContent = 'Não informado';
    }
  }

  if (notesEl) {
    notesEl.textContent = schedItem.notes || 'Nenhuma observação cadastrada para este horário.';
  }

  modal.classList.remove('hidden');
}

function closeEventDetailModal() {
  const modal = document.getElementById('modal-schedule-event-detail');
  if (modal) modal.classList.add('hidden');
}

// ---------------------------------------------------------
// MODAL: AMARRAR PROFESSOR COM ALUNO (FILA DE MATRÍCULAS)
// ---------------------------------------------------------
function openBindTeacherModal() {
  const modal = document.getElementById('modal-bind-teacher');
  if (!modal) return;

  renderPendingStudentsList();

  // Popula os selects do form de amarração
  const teacherSel = document.getElementById('bind-teacher-select');
  if (teacherSel) {
    teacherSel.innerHTML = '<option value="">Selecione o Professor...</option>' + assignableTeacherOptions();
  }

  const subSel = document.getElementById('bind-subject-select');
  if (subSel) {
    let html = '<option value="">Sem matéria fixa</option>';
    (state.subjects || []).forEach(s => {
      html += `<option value="${s.id}">${s.name}</option>`;
    });
    subSel.innerHTML = html;
  }

  // Esconde o card de amarração ativa até selecionar um aluno
  const actionCard = document.getElementById('bind-action-card');
  if (actionCard) actionCard.classList.add('hidden');

  modal.classList.remove('hidden');
}

function closeBindTeacherModal() {
  const modal = document.getElementById('modal-bind-teacher');
  if (modal) modal.classList.add('hidden');
}

function renderPendingStudentsList() {
  const container = document.getElementById('pending-students-list');
  if (!container) return;

  const list = state.pendingStudents || [];

  if (list.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 30px; background: #ffffff; border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
        <p style="color: var(--text-muted); font-size: 0.95rem;">🎉 Nenhum aluno aguardando professor no momento! Todas as matrículas estão ativas com horários na grade.</p>
      </div>
    `;
    return;
  }

  const dayNames = { 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex', 6: 'Sáb', 0: 'Dom' };

  container.innerHTML = list.map(st => {
    const freqDisplay = st.frequency_type === 'quinzenal'
      ? '🌓 Quinzenal (15 dias)'
      : (st.frequency_type === 'custom_dias' ? `⚙️ A cada ${st.custom_interval_days || 3} dias` : '📅 Semanal');

    const daysDisplay = String(st.preferred_days || '1').split(',')
      .map(d => dayNames[d.trim()] || d.trim())
      .join(', ');

    return `
      <div class="pending-student-card">
        <div class="pending-student-top">
          <div>
            <div class="pending-student-name">${st.name}</div>
            <div class="pending-student-goal">${st.objective_grade || 'Matrícula recente'}</div>
          </div>
          <span class="badge-count" style="background: #f97316;">Pendente</span>
        </div>

        <div class="pending-student-specs">
          <span class="pending-spec-pill">${freqDisplay}</span>
          <span class="pending-spec-pill">Dias: ${daysDisplay}</span>
          <span class="pending-spec-pill">🕒 ${st.preferred_time || '08:00'} (${st.duration_minutes || 60}m)</span>
        </div>

        ${st.enrollment_notes ? `
          <div style="font-size: 0.76rem; color: var(--text-muted); font-style: italic;">
            💡 ${st.enrollment_notes}
          </div>
        ` : ''}

        <button type="button" class="btn-bind-student" data-student-id="${st.id}">
          <span>🔗 Amarrar Professor & Horário</span>
        </button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-bind-student').forEach(btn => {
    btn.addEventListener('click', () => {
      const studentId = btn.getAttribute('data-student-id');
      prepareBindingForm(studentId);
    });
  });
}

function prepareBindingForm(studentId) {
  const student = (state.pendingStudents || []).find(s => String(s.id) === String(studentId));
  if (!student) return;

  const card = document.getElementById('bind-action-card');
  const targetName = document.getElementById('bind-target-student-name');
  const idInput = document.getElementById('bind-student-id');
  const daySelect = document.getElementById('bind-day-of-week');
  const freqSelect = document.getElementById('bind-frequency-type');
  const customDaysInput = document.getElementById('bind-custom-days');
  const customGroup = document.getElementById('bind-group-custom-days');
  const startTimeInput = document.getElementById('bind-start-time');
  const endTimeInput = document.getElementById('bind-end-time');
  const subSelect = document.getElementById('bind-subject-select');

  if (targetName) targetName.textContent = student.name;
  if (idInput) idInput.value = student.id;

  // Preenche valores com as preferências de matrícula do aluno
  const firstPrefDay = String(student.preferred_days || '1').split(',')[0].trim();
  if (daySelect) daySelect.value = firstPrefDay;

  if (freqSelect) {
    freqSelect.value = student.frequency_type || 'semanal';
    if (freqSelect.value === 'custom_dias') {
      customGroup.classList.remove('hidden');
      if (customDaysInput) customDaysInput.value = student.custom_interval_days || 3;
    } else {
      customGroup.classList.add('hidden');
    }
  }

  const sTime = student.preferred_time || '08:00';
  if (startTimeInput) startTimeInput.value = sTime;

  // Calcula término baseado na duração
  const [sh, sm] = sTime.split(':').map(Number);
  const dur = student.duration_minutes || 60;
  const totMin = sh * 60 + sm + dur;
  const endH = String(Math.floor(totMin / 60)).padStart(2, '0');
  const endM = String(totMin % 60).padStart(2, '0');
  if (endTimeInput) endTimeInput.value = `${endH}:${endM}`;

  if (subSelect && student.subjects && student.subjects.length > 0) {
    subSelect.value = student.subjects[0].id;
  }

  if (card) {
    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function handleBindTeacherSubmit(e) {
  e.preventDefault();
  const studentId = document.getElementById('bind-student-id').value;
  const teacherId = document.getElementById('bind-teacher-select').value;

  if (!studentId || !teacherId) {
    showAppAlert('Por favor, selecione um professor para amarrar ao aluno.', 'Matrícula');
    return;
  }

  const freq = document.getElementById('bind-frequency-type').value;
  const intervalVal = document.getElementById('bind-custom-days') ? parseInt(document.getElementById('bind-custom-days').value) : (freq === 'quinzenal' ? 14 : 7);

  const payload = {
    teacher_id: parseInt(teacherId),
    subject_id: document.getElementById('bind-subject-select').value ? parseInt(document.getElementById('bind-subject-select').value) : null,
    day_of_week: parseInt(document.getElementById('bind-day-of-week').value),
    frequency_type: freq,
    recurrence_interval_days: intervalVal,
    start_time: document.getElementById('bind-start-time').value,
    end_time: document.getElementById('bind-end-time').value,
    room_or_info: document.getElementById('bind-room').value
  };

  try {
    const res = await fetch(`${API_BASE}/api/students/${studentId}/bind-teacher`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao vincular professor');

    showToast(' Professor amarrado ao aluno com sucesso e horário publicado na Grade!');
    closeBindTeacherModal();
    await loadSchedules();
    await loadPendingStudents();
    await loadStudents();
    await loadAdminStudents();
  } catch (err) {
    showAppAlert(err.message, 'Erro de Vinculação');
  }
}

// ---------------------------------------------------------
// MODAL: CADASTRO / EDIÇÃO DE HORÁRIO NA GRADE (ADMIN)
// ---------------------------------------------------------
async function openScheduleModal(scheduleId = null) {
  if (!state.currentUser || state.currentUser.role !== 'admin') {
    showAppAlert('Apenas o administrador tem permissão para cadastrar ou alterar a grade de horários.', 'Acesso Restrito');
    return;
  }

  const modal = document.getElementById('modal-schedule-admin');
  const title = document.getElementById('schedule-modal-title');
  const form = document.getElementById('form-schedule-admin');
  form.reset();

  const teacherSelect = document.getElementById('sched-teacher-id');
  if (state.teachers.length === 0) {
    try {
      const res = await fetch(`${API_BASE}/api/teachers`, { headers: getAuthHeaders() });
      if (res.ok) state.teachers = await res.json();
    } catch (e) {}
  }
  teacherSelect.innerHTML = '<option value="">Selecione o professor...</option>' + assignableTeacherOptions();

  const studentSelect = document.getElementById('sched-student-id');
  studentSelect.innerHTML = '<option value="">-- Horário Livre / Sem Aluno Vinculado --</option>' + (state.students || []).map(st => `
    <option value="${st.id}">🎓 ${st.name}</option>
  `).join('');

  const subjectSelect = document.getElementById('sched-subject-id');
  subjectSelect.innerHTML = '<option value="">Sem matéria fixa (Geral)</option>' + state.subjects.map(s => `
    <option value="${s.id}">${s.name}</option>
  `).join('');

  const roomSelect = document.getElementById('sched-classroom-id');
  if (roomSelect) {
    roomSelect.innerHTML = (state.classrooms || []).map(r => `
      <option value="${r.id}">${r.type === 'presencial' ? '🏫' : '🌐'} ${r.name} (${r.capacity_students} alunos máx.)</option>
    `).join('');
  }

  function updateSchedRoomBadge() {
    const badge = document.getElementById('sched-classroom-info-badge');
    if (!badge || !roomSelect) return;
    const r = (state.classrooms || []).find(rm => String(rm.id) === String(roomSelect.value));
    if (r) {
      const isOnline = r.type === 'online';
      badge.style.display = 'block';
      badge.innerHTML = `
        <strong>${isOnline ? '🌐 Ambiente Virtual' : '🏫 Sala Presencial'}:</strong> Capacidade de até <b>${r.capacity_students} alunos</b> e <b>${r.capacity_teachers} professor(a)</b> simultâneo(a).
        <div style="margin-top:4px;">
          ${(Array.isArray(r.resources) ? r.resources : []).map(res => `<span class="resource-tag">✓ ${getResourceName(res)}</span>`).join(' ')}
        </div>
      `;
      const roomInput = document.getElementById('sched-room');
      if (roomInput) roomInput.value = r.name;
    } else {
      badge.style.display = 'none';
    }
  }

  if (roomSelect) {
    roomSelect.onchange = updateSchedRoomBadge;
  }

  subjectSelect.onchange = () => {
    const sub = (state.subjects || []).find(sb => String(sb.id) === String(subjectSelect.value));
    if (sub && sub.classroom_id && roomSelect) {
      roomSelect.value = sub.classroom_id;
      updateSchedRoomBadge();
    }
  };

  const freqSelect = document.getElementById('sched-frequency-type');
  const customIntervalGroup = document.getElementById('group-sched-custom-interval');

  if (scheduleId) {
    const s = state.schedules.find(item => String(item.id) === String(scheduleId));
    if (!s) return;

    title.textContent = 'Editar Horário do Professor';
    document.getElementById('schedule-edit-id').value = s.id;
    teacherSelect.value = s.teacher_id;
    studentSelect.value = s.student_id || '';
    subjectSelect.value = s.subject_id || '';
    document.getElementById('sched-day-of-week').value = s.day_of_week;
    document.getElementById('sched-start-time').value = s.start_time;
    document.getElementById('sched-end-time').value = s.end_time;
    document.getElementById('sched-room').value = s.room_or_info || 'Sala 01 - Presencial';
    document.getElementById('sched-notes').value = s.notes || '';

    if (roomSelect) {
      if (s.classroom_id) {
        roomSelect.value = s.classroom_id;
      } else if (s.subject_id) {
        const sub = (state.subjects || []).find(sb => String(sb.id) === String(s.subject_id));
        if (sub && sub.classroom_id) roomSelect.value = sub.classroom_id;
      }
      updateSchedRoomBadge();
    }

    if (freqSelect) {
      freqSelect.value = s.resolved_frequency || s.frequency_type || 'semanal';
      if (freqSelect.value === 'custom_dias') {
        customIntervalGroup.classList.remove('hidden');
        document.getElementById('sched-custom-interval').value = s.resolved_interval_days || 7;
      } else {
        customIntervalGroup.classList.add('hidden');
      }
    }
  } else {
    title.textContent = 'Cadastrar Novo Horário';
    document.getElementById('schedule-edit-id').value = '';
    document.getElementById('sched-start-time').value = '08:00';
    document.getElementById('sched-end-time').value = '09:30';
    document.getElementById('sched-room').value = 'Sala 01 - Presencial';
    if (roomSelect && state.classrooms.length > 0) {
      roomSelect.value = state.classrooms[0].id;
      updateSchedRoomBadge();
    }
    if (freqSelect) {
      freqSelect.value = 'semanal';
      customIntervalGroup.classList.add('hidden');
    }
  }

  modal.classList.remove('hidden');
}

function closeScheduleModal() {
  const modal = document.getElementById('modal-schedule-admin');
  if (modal) modal.classList.add('hidden');
}

async function handleDeleteSchedule(scheduleId) {
  showAppConfirm('Deseja realmente remover este horário da grade de aulas?', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/schedules/${scheduleId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao remover horário');
      showToast('Horário removido com sucesso!');
      await loadSchedules();
      await loadPendingStudents();
    } catch (err) {
      showAppAlert(err.message, 'Erro ao Remover Horário');
    }
  }, 'Remover Horário da Grade', true);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  const msgEl = document.getElementById('toast-message');
  msgEl.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}

// ==========================================
// PORTAL DA FAMÍLIA (ÁREA EXCLUSIVA DOS PAIS)
// ==========================================

async function loadParentPortalData(overrideStudentId = null) {
  try {
    let studentUrl = `${API_BASE}/api/parent/student`;
    if (overrideStudentId) {
      studentUrl += `?student_id=${overrideStudentId}`;
    }

    const res = await fetch(studentUrl, { headers: getAuthHeaders() });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Erro ao carregar dados do aluno');
    }

    const data = await res.json();
    state.parentStudent = data.student;
    state.parentSchedules = data.schedules || [];

    renderParentHero(data.student);
    renderParentSchedules();
    await loadParentAgenda(overrideStudentId || (data.student ? data.student.id : null));
    await loadParentClasses(overrideStudentId || (data.student ? data.student.id : null));
    await loadParentReport(overrideStudentId || (data.student ? data.student.id : null));
  } catch (err) {
    console.error('Erro ao carregar portal dos pais:', err);
    showToast('Não foi possível carregar todas as informações do portal.');
  }
}

function renderParentHero(student) {
  if (!student) return;

  const nameEl = document.getElementById('parent-hero-student-name');
  const statusEl = document.getElementById('parent-hero-status');
  const gradeEl = document.getElementById('parent-hero-grade');
  const codeEl = document.getElementById('parent-hero-code');
  const avatarEl = document.getElementById('parent-hero-avatar');
  const subjectsContainer = document.getElementById('parent-hero-subjects');

  if (nameEl) nameEl.textContent = student.name;
  if (statusEl) {
    statusEl.textContent = student.status === 'ativo' ? 'Matriculado(a)' : (student.status || 'Ativo');
  }
  if (gradeEl) gradeEl.textContent = student.objective_grade || 'Ensino Completo / Reforço';
  if (codeEl) codeEl.textContent = student.parent_access_code || ('PAIS-' + student.id);

  // Avatar emoji amigável
  if (avatarEl) {
    const n = (student.name || '').toLowerCase();
    if (n.includes('ana') || n.includes('maria') || n.includes('sabrina') || n.includes('clara')) {
      avatarEl.textContent = '👧';
    } else {
      avatarEl.textContent = '👦';
    }
  }

  // Badges de matérias
  if (subjectsContainer) {
    const subs = student.subjects || [];
    if (subs.length > 0) {
      subjectsContainer.innerHTML = subs.map(s => `<span class="subject-tag" style="background:#e0f2fe; color:#0284c7; font-weight:700;">${s.name}</span>`).join('');
    } else {
      subjectsContainer.innerHTML = '<span class="text-xs text-muted">Grade Geral</span>';
    }
  }

  // KPIs
  const totalEl = document.getElementById('parent-kpi-total');
  const presEl = document.getElementById('parent-kpi-presences');
  const absEl = document.getElementById('parent-kpi-absences');
  const rateEl = document.getElementById('parent-kpi-rate');

  if (totalEl) totalEl.textContent = student.total_classes || 0;
  if (presEl) presEl.textContent = student.total_presences || 0;
  if (absEl) absEl.textContent = student.total_absences || 0;
  if (rateEl) {
    const total = parseInt(student.total_classes) || 0;
    const pres = parseInt(student.total_presences) || 0;
    rateEl.textContent = total > 0 ? `${Math.round((pres / total) * 1000) / 10}%` : '—';
  }
}

async function loadParentAgenda(studentId = null) {
  try {
    let url = `${API_BASE}/api/parent/agenda`;
    if (studentId) url += `?student_id=${studentId}`;

    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Erro ao buscar recados');
    state.parentAgenda = await res.json();

    // Atualiza contador de não lidos
    const unreadCount = state.parentAgenda.filter(a => !a.read_by_parent).length;
    const badge = document.getElementById('parent-agenda-unread-count');
    if (badge) {
      badge.textContent = unreadCount;
      badge.classList.toggle('hidden', unreadCount === 0);
    }

    renderParentAgenda();
  } catch (err) {
    console.error('Erro ao carregar agenda dos pais:', err);
  }
}

function renderParentAgenda() {
  const container = document.getElementById('parent-agenda-list');
  if (!container) return;

  let list = state.parentAgenda || [];

  if (state.parentActiveCategory) {
    if (state.parentActiveCategory === 'importante') {
      list = list.filter(a => a.is_important);
    } else {
      list = list.filter(a => a.category === state.parentActiveCategory);
    }
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div class="card-box" style="text-align: center; padding: 36px 16px;">
        <div style="font-size: 2.2rem; margin-bottom: 8px;">📭</div>
        <h4 style="font-size: 1.05rem; margin-bottom: 6px; color: var(--brand-blue);">Nenhum recado nesta categoria</h4>
        <p class="text-sm text-muted">A escola e os professores utilizam esta agenda para enviar comunicados, tarefas de casa e elogios.</p>
      </div>
    `;
    return;
  }

  const catMeta = {
    recado: { icon: '💬', label: 'Recado Geral', class: 'recado' },
    tarefa: { icon: '📝', label: 'Tarefa / Lição', class: 'tarefa' },
    elogio: { icon: '⭐', label: 'Elogio & Destaque', class: 'elogio' },
    aviso: { icon: '📢', label: 'Aviso Importante', class: 'aviso' },
    desempenho: { icon: '📊', label: 'Desempenho', class: 'desempenho' }
  };

  container.innerHTML = list.map(item => {
    const meta = catMeta[item.category] || catMeta.recado;
    const isImportant = item.is_important;
    const hasResponse = Boolean(item.parent_response);

    return `
      <div class="agenda-card ${isImportant ? 'important' : ''}" data-agenda-id="${item.id}">
        <div class="agenda-card-header">
          <span class="agenda-cat-badge ${meta.class}">
            <span>${meta.icon}</span>
            <span>${meta.label}</span>
          </span>
          <span class="agenda-date-time-tag">
            🕒 ${item.formatted_date_time || item.entry_date_br || ''}
          </span>
        </div>

        <h3 class="agenda-title">${item.title}</h3>
        <p class="agenda-content-text">${item.content}</p>

        <div class="agenda-meta-row">
          <span class="agenda-author">✍️ Postado por: <strong>${item.author_name || 'Equipe Entrelinhas'}</strong></span>
          <div class="agenda-read-status ${item.read_by_parent ? 'read' : 'unread'}">
            ${item.read_by_parent 
              ? `<span>✓ Confirmado em ${item.read_at_formatted || 'Data confirmada'}</span>`
              : `<button class="btn-confirm-read" data-action-read="${item.id}">👍 Confirmar Leitura / Ciente</button>`
            }
          </div>
        </div>

        <!-- Seção de Resposta dos Pais -->
        <div class="agenda-reply-section">
          ${hasResponse ? `
            <div class="agenda-reply-bubble">
              <strong>💬 Resposta enviada pela família ${item.parent_response_at_formatted ? `(${item.parent_response_at_formatted})` : ''}:</strong>
              <span>${item.parent_response}</span>
            </div>
          ` : `
            <div class="agenda-reply-toggle-area" id="reply-box-${item.id}">
              <div class="agenda-reply-composer">
                <input type="text" id="input-reply-${item.id}" placeholder="Escreva uma resposta para os professores / escola...">
                <button class="btn-send-reply" data-send-reply="${item.id}">Enviar</button>
              </div>
            </div>
          `}
        </div>
      </div>
    `;
  }).join('');

  // Eventos de confirmar leitura
  container.querySelectorAll('[data-action-read]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-action-read');
      await confirmAgendaRead(id);
    });
  });

  // Eventos de enviar resposta
  container.querySelectorAll('[data-send-reply]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-send-reply');
      const input = document.getElementById(`input-reply-${id}`);
      const text = input ? input.value.trim() : '';
      if (!text) {
        showAppAlert('Por favor, digite sua mensagem antes de enviar.', 'Agenda da Família');
        return;
      }
      await sendAgendaReply(id, text);
    });
  });
}

async function confirmAgendaRead(agendaId) {
  try {
    const res = await fetch(`${API_BASE}/api/parent/agenda/${agendaId}/read`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ student_id: state.parentStudent ? state.parentStudent.id : null })
    });
    if (!res.ok) throw new Error('Falha ao confirmar leitura');
    showToast('Confirmação de leitura registrada com sucesso!');
    await loadParentAgenda(state.parentStudent ? state.parentStudent.id : null);
    loadParentFamilyMessages();
  } catch (err) {
    showAppAlert(err.message, 'Confirmação de Leitura');
  }
}

async function sendAgendaReply(agendaId, text) {
  try {
    const res = await fetch(`${API_BASE}/api/parent/agenda/${agendaId}/respond`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        response: text,
        student_id: state.parentStudent ? state.parentStudent.id : null
      })
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || 'Falha ao enviar resposta');
    }
    showToast('Resposta enviada com sucesso à equipe da escola!');
    await loadParentAgenda(state.parentStudent ? state.parentStudent.id : null);
  } catch (err) {
    showAppAlert(err.message, 'Resposta da Família');
  }
}

function renderParentSchedules() {
  const container = document.getElementById('parent-schedule-list');
  if (!container) return;

  let list = state.parentSchedules || [];

  if (state.parentActiveDay !== '') {
    const day = parseInt(state.parentActiveDay);
    list = list.filter(s => s.day_of_week === day);
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div class="card-box" style="text-align: center; padding: 32px 16px;">
        <div style="font-size: 2rem; margin-bottom: 6px;">🕒</div>
        <h4 style="font-size: 1rem; color: var(--brand-blue);">Nenhuma aula configurada para este dia</h4>
        <p class="text-xs text-muted">Consulte a coordenação pedagógica para confirmar os horários de reforço e matérias.</p>
      </div>
    `;
    return;
  }

  const dayMeta = {
    1: { name: 'Segunda-feira', icon: '🔵' },
    2: { name: 'Terça-feira', icon: '🟢' },
    3: { name: 'Quarta-feira', icon: '🟠' },
    4: { name: 'Quinta-feira', icon: '🟣' },
    5: { name: 'Sexta-feira', icon: '🔴' },
    6: { name: 'Sábado', icon: '⭐' },
    0: { name: 'Domingo', icon: '⚪' }
  };

  // Agrupa por dia
  const byDay = {};
  list.forEach(s => {
    if (!byDay[s.day_of_week]) byDay[s.day_of_week] = [];
    byDay[s.day_of_week].push(s);
  });

  const sortedDays = Object.keys(byDay).map(Number).sort((a, b) => a - b);

  let html = '';
  sortedDays.forEach(dayNum => {
    const dayList = byDay[dayNum];
    dayList.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    const meta = dayMeta[dayNum] || { name: 'Dia ' + dayNum, icon: '📅' };

    html += `
      <div class="schedule-day-group">
        <div class="schedule-day-header">
          <div class="schedule-day-title">
            <span class="schedule-day-icon">${meta.icon}</span>
            <h3>${meta.name}</h3>
          </div>
          <span class="schedule-day-badge">${dayList.length} aula(s)</span>
        </div>

        <div class="schedule-cards-grid">
          ${dayList.map(s => {
            const freq = s.frequency_type === 'quinzenal' ? 'Quinzenal'
              : s.frequency_type === 'custom_dias' ? `A cada ${s.recurrence_interval_days || 3} dias` : 'Semanal';
            // Notas geradas automaticamente pelo sistema não interessam à família
            const notes = s.notes && !/^(Matrícula:|Aula regular)/i.test(s.notes) ? s.notes : '';
            return `
            <div class="schedule-item-card">
              <div class="schedule-card-top">
                <span class="schedule-time-badge">🕒 ${escapeHtml(s.start_time)} – ${escapeHtml(s.end_time)}</span>
                <span class="schedule-freq-tag">${freq}</span>
              </div>
              <h4 class="schedule-subject">${escapeHtml(s.subject_name || 'Aula')}</h4>
              <div class="schedule-teacher-row">
                <div class="schedule-teacher-avatar">${escapeHtml((s.teacher_name || 'P').charAt(0).toUpperCase())}</div>
                <div class="schedule-teacher-name">${escapeHtml(s.teacher_name || 'Professor(a)')}</div>
              </div>
              <div class="schedule-room-info">📍 ${escapeHtml(s.room_or_info || 'Presencial')}</div>
              ${notes ? `<div class="schedule-notes-text">💡 ${escapeHtml(notes)}</div>` : ''}
            </div>
          `;
          }).join('')}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

async function loadParentClasses(studentId = null) {
  try {
    let url = `${API_BASE}/api/parent/classes`;
    if (studentId) url += `?student_id=${studentId}`;

    const res = await fetch(url, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Erro ao buscar aulas');
    state.parentClasses = await res.json();
    renderParentClasses();
  } catch (err) {
    console.error('Erro ao carregar aulas dos pais:', err);
  }
}

function renderParentClasses() {
  const container = document.getElementById('parent-diary-list');
  if (!container) return;

  const list = state.parentClasses || [];

  if (list.length === 0) {
    container.innerHTML = `
      <div class="card-box" style="text-align: center; padding: 36px 16px;">
        <div style="font-size: 2rem; margin-bottom: 6px;">📖</div>
        <h4 style="font-size: 1rem; color: var(--brand-blue);">Nenhuma aula lançada até o momento</h4>
        <p class="text-xs text-muted">Assim que os professores registrarem o conteúdo trabalhado em sala, o histórico completo aparecerá aqui.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = list.map(log => {
    const isFalta = log.status === 'falta';
    const dt = log.formatted_date_time || formatLogDateTime(log);

    return `
      <div class="log-card" style="border-left: 4px solid ${isFalta ? 'var(--danger)' : 'var(--success)'};">
        <div class="log-header">
          <div>
            <span class="subject-tag" style="background:#e0f2fe; color:#0284c7; font-weight:700;">${log.subject_name || 'Geral'}</span>
            <span style="font-size:0.85rem; font-weight:700; color:var(--brand-blue); margin-left:6px;">Prof. ${log.teacher_display_name || log.teacher_name || 'Equipe'}</span>
          </div>
          <span class="log-status-chip ${log.status}">${log.status === 'presente' ? '✅ Presente' : '❌ Falta'}</span>
        </div>

        <div style="margin-bottom: 8px;">
          <span class="log-date" style="font-weight: 700; color: var(--brand-blue);">📅 ${dt}</span>
        </div>

        ${!isFalta ? `
          <p class="log-content-text"><strong>Conteúdo Trabalhado:</strong> ${log.content || 'Atividades regulares'}</p>
        ` : `
          <p class="log-content-text" style="color: var(--danger); font-weight:600;">Aluno(a) ausente nesta data de aula.</p>
        `}

        ${log.incidents && log.incidents !== 'Sem intercorrências' ? `
          <div class="log-details-block" style="background:var(--warning-bg); border-left:3px solid var(--warning); margin-top:6px; padding:6px 10px; border-radius:4px;">
            <strong style="color:var(--warning-hover);">Intercorrência:</strong> <em>${log.incidents}</em>
          </div>
        ` : ''}

        ${log.pedagogical_notes ? `
          <div class="log-details-block" style="background:#f1f5f9; border-left:3px solid var(--brand-sky); margin-top:6px; padding:6px 10px; border-radius:4px;">
            <strong style="color:var(--brand-blue);">Observação Pedagógica:</strong> ${log.pedagogical_notes}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function switchParentSubtab(subtabId) {
  // O subtabId pode ser 'parent-tab-agenda', 'parent-tab-schedule', 'parent-tab-diary', 'parent-tab-contact'
  const subviews = document.querySelectorAll('.parent-subview-content');
  subviews.forEach(v => v.classList.add('hidden'));

  const target = document.getElementById(subtabId);
  if (target) {
    target.classList.remove('hidden');
    target.classList.add('active');
  }

  // Sincroniza abas segmentadas
  document.querySelectorAll('.parent-segmented-tabs .parent-subtab').forEach(b => {
    if (b.getAttribute('data-subview') === subtabId) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });

  // Sincroniza navegação desktop e mobile dos pais
  document.querySelectorAll('[data-parent-subtab]').forEach(b => {
    if (b.getAttribute('data-parent-subtab') === subtabId) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });
  // No celular a barra inferior rola na horizontal: mantém a aba ativa à vista
  document.querySelectorAll('#bottom-nav-parent .nav-tab.active').forEach(tab => {
    tab.scrollIntoView({ block: 'nearest', inline: 'center' });
  });

  // Se clicou no horário, re-renderiza
  if (subtabId === 'parent-tab-schedule') {
    renderParentSchedules();
  } else if (subtabId === 'parent-tab-report') {
    renderParentReport();
  } else if (subtabId === 'parent-tab-online') {
    loadStudentOnlineClasses();
  } else if (subtabId === 'parent-tab-finance') {
    loadStudentInvoices();
  }
}

async function loadParentReport(studentId = null) {
  const targetId = studentId || (state.parentStudent ? state.parentStudent.id : null);
  if (!targetId) return;

  try {
    const res = await fetch(`${API_BASE}/api/reports/student/${targetId}`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Não foi possível carregar o relatório pedagógico.');
    const data = await res.json();
    state.parentReportData = data;
    renderParentReport();
  } catch (err) {
    console.error('Erro ao carregar relatório dos pais:', err);
    const container = document.getElementById('parent-report-container');
    if (container) {
      container.innerHTML = `<p style="color:var(--danger); text-align:center; padding:20px;">${err.message}</p>`;
    }
  }
}

function renderParentReport() {
  renderParentPedagogicalReports();
  const container = document.getElementById('parent-report-container');
  if (!container) return;

  const data = state.parentReportData;
  if (!data || !data.student) {
    container.innerHTML = `
      <div class="card-box" style="text-align: center; padding: 36px 16px;">
        <div style="font-size: 2.2rem; margin-bottom: 8px;">📑</div>
        <h4 style="font-size: 1.05rem; margin-bottom: 6px; color: var(--brand-blue);">Relatório em Processamento</h4>
        <p class="text-sm text-muted">Os dados consolidados de presença e desempenho estarão disponíveis em instantes.</p>
      </div>
    `;
    return;
  }

  const { student, stats, logs, emission_date_time } = data;
  const breakdown = (stats && stats.subjects_breakdown) || {};
  const subjectKeys = Object.keys(breakdown);

  container.innerHTML = `
    <div class="parent-report-sheet" style="background:#ffffff; border:1px solid var(--border-color); border-radius:var(--radius-lg); padding:22px; box-shadow:var(--shadow-sm);">
      
      <!-- Cabeçalho do Relatório -->
      <div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid var(--brand-sky-light); padding-bottom:14px; margin-bottom:18px; flex-wrap:wrap; gap:10px;">
        <div>
          <span style="font-size:0.75rem; font-weight:800; text-transform:uppercase; color:var(--brand-orange); letter-spacing:0.5px;">Boletim de Frequência & Desenvolvimento</span>
          <h2 style="font-family:var(--font-title); font-size:1.35rem; font-weight:800; color:var(--brand-blue); margin:4px 0;">${student.name}</h2>
          <div style="font-size:0.84rem; color:var(--text-muted); display:flex; gap:12px; flex-wrap:wrap;">
            <span>🎓 <strong>Objetivo/Série:</strong> ${student.objective_grade || 'Ensino Regular / Reforço'}</span>
            <span>👨‍👩‍👧 <strong>Responsável:</strong> ${student.parent_name || 'Família'}</span>
            <span>🔑 <strong>Código:</strong> ${student.parent_access_code || ('PAIS-' + student.id)}</span>
          </div>
        </div>
        <div style="text-align:right;">
          <span style="font-size:0.75rem; color:var(--text-muted); display:block;">Data de Emissão</span>
          <strong style="font-size:0.85rem; color:var(--brand-blue);">${emission_date_time || 'Hoje'}</strong>
        </div>
      </div>

      <!-- Indicadores Gerais (KPIs) -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px; margin-bottom:20px;">
        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:var(--radius-md); padding:12px; text-align:center;">
          <span style="font-size:1.4rem; font-weight:800; color:var(--brand-blue); display:block;">${stats ? stats.total_classes : 0}</span>
          <span style="font-size:0.75rem; font-weight:700; color:var(--text-muted); text-transform:uppercase;">Total de Aulas</span>
        </div>
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:var(--radius-md); padding:12px; text-align:center;">
          <span style="font-size:1.4rem; font-weight:800; color:#16a34a; display:block;">${stats ? stats.total_presences : 0}</span>
          <span style="font-size:0.75rem; font-weight:700; color:#15803d; text-transform:uppercase;">Presenças</span>
        </div>
        <div style="background:#fff1f2; border:1px solid #fecdd3; border-radius:var(--radius-md); padding:12px; text-align:center;">
          <span style="font-size:1.4rem; font-weight:800; color:#e11d48; display:block;">${stats ? stats.total_absences : 0}</span>
          <span style="font-size:0.75rem; font-weight:700; color:#be123c; text-transform:uppercase;">Faltas</span>
        </div>
        <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:var(--radius-md); padding:12px; text-align:center;">
          <span style="font-size:1.4rem; font-weight:800; color:#d97706; display:block;">${stats && stats.total_classes > 0 ? stats.attendance_rate + '%' : '—'}</span>
          <span style="font-size:0.75rem; font-weight:700; color:#b45309; text-transform:uppercase;">Assiduidade</span>
        </div>
      </div>

      <!-- Desempenho por Matéria -->
      <div style="margin-bottom:24px;">
        <h4 style="font-size:0.95rem; font-weight:800; color:var(--brand-blue); margin-bottom:10px; display:flex; align-items:center; gap:6px;">
          📚 Detalhamento por Disciplina
        </h4>
        ${subjectKeys.length > 0 ? `
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px;">
            ${subjectKeys.map(subName => {
              const sub = breakdown[subName];
              const subRate = sub.total > 0 ? Math.round((sub.presences / sub.total) * 100) : 100;
              return `
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:var(--radius-md); padding:12px 14px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <strong style="color:var(--brand-blue); font-size:0.9rem;">${subName}</strong>
                    <span style="font-size:0.75rem; font-weight:800; color:${subRate >= 75 ? '#16a34a' : '#e11d48'};">${subRate}%</span>
                  </div>
                  <div style="font-size:0.78rem; color:var(--text-muted); display:flex; justify-content:space-between;">
                    <span>Aulas: <strong>${sub.total}</strong></span>
                    <span>Presenças: <strong>${sub.presences}</strong></span>
                    <span>Faltas: <strong style="color:${sub.absences > 0 ? '#e11d48' : 'inherit'};">${sub.absences}</strong></span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        ` : `
          <p class="text-xs text-muted">Ainda não há registros de matérias específicas lançadas.</p>
        `}
      </div>

      <!-- Histórico Cronológico de Aulas e Conteúdos -->
      <div>
        <h4 style="font-size:0.95rem; font-weight:800; color:var(--brand-blue); margin-bottom:12px; display:flex; align-items:center; gap:6px;">
          📅 Histórico de Aulas & Conteúdos Trabalhados
        </h4>
        ${logs && logs.length > 0 ? `
          <div style="display:flex; flex-direction:column; gap:10px;">
            ${logs.map(log => {
              const isPresente = log.status === 'presente';
              return `
                <div style="border:1px solid #e2e8f0; border-left:4px solid ${isPresente ? '#16a34a' : '#e11d48'}; border-radius:var(--radius-sm); padding:10px 14px; background:#ffffff;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; flex-wrap:wrap; gap:6px;">
                    <div>
                      <strong style="font-size:0.88rem; color:var(--brand-blue);">${log.subject_name || 'Reforço Geral'}</strong>
                      <span style="font-size:0.78rem; color:var(--text-muted); margin-left:6px;">• Prof. ${log.teacher_display_name || 'Equipe'}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                      <span style="font-size:0.76rem; color:var(--text-muted); font-weight:600;">🕒 ${log.formatted_date_time || log.class_date_br}</span>
                      <span style="font-size:0.72rem; font-weight:800; padding:2px 8px; border-radius:var(--radius-full); background:${isPresente ? '#f0fdf4' : '#fff1f2'}; color:${isPresente ? '#16a34a' : '#e11d48'};">
                        ${isPresente ? 'Presente' : 'Falta'}
                      </span>
                    </div>
                  </div>
                  <p style="font-size:0.84rem; color:var(--text-main); margin:4px 0; line-height:1.4;">
                    <strong>Conteúdo:</strong> ${log.content || 'Atividades regulares trabalhadas em aula.'}
                  </p>
                  ${log.incidents && log.incidents !== 'Sem intercorrências' ? `
                    <div style="font-size:0.78rem; color:#b45309; background:#fffbeb; padding:4px 8px; border-radius:4px; margin-top:4px;">
                      ⚠️ <strong>Observação:</strong> ${log.incidents}
                    </div>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        ` : `
          <p class="text-xs text-muted">Nenhum registro de aula localizado para este período.</p>
        `}
      </div>

    </div>
  `;

  const btnPrint = document.getElementById('btn-print-parent-report');
  if (btnPrint) {
    btnPrint.onclick = () => window.print();
  }
}

// ==========================================
// MODAL DE GESTÃO DA AGENDA (PROFESSORES & ADMIN)
// ==========================================

function openStudentAgendaModal(studentId) {
  state.currentAgendaStudentId = studentId;
  const student = (state.students || []).find(s => String(s.id) === String(studentId)) ||
                  (state.adminStudents || []).find(s => String(s.id) === String(studentId));

  const modal = document.getElementById('modal-student-agenda');
  const nameEl = document.getElementById('modal-agenda-student-name');
  const metaEl = document.getElementById('modal-agenda-meta');
  const hiddenId = document.getElementById('agenda-target-student-id');
  const spTime = document.getElementById('agenda-date-time-display');

  if (student) {
    nameEl.textContent = `Agenda: ${student.name}`;
    metaEl.textContent = `Código dos Pais: ${student.parent_access_code || ('PAIS-' + student.id)} • ${student.objective_grade || 'Diário de Classe'}`;
  } else {
    nameEl.textContent = 'Agenda de Recados';
  }

  if (hiddenId) hiddenId.value = studentId;

  const nowSP = getSaoPauloDateAndTimeString();
  if (spTime) spTime.value = nowSP.formatted;

  document.getElementById('form-add-agenda').reset();
  if (hiddenId) hiddenId.value = studentId;
  if (spTime) spTime.value = nowSP.formatted;

  loadAgendaMessages(studentId);
  loadStaffFamilyMessages(studentId);
  modal.classList.remove('hidden');
}

async function loadAgendaMessages(studentId) {
  const container = document.getElementById('agenda-messages-list');
  const counter = document.getElementById('agenda-history-counter');
  if (!container) return;

  container.innerHTML = '<div style="text-align:center; padding:16px;">Carregando mensagens...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/students/${studentId}/agenda`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error('Erro ao carregar recados da agenda');
    const messages = await res.json();

    if (counter) counter.textContent = `${messages.length} recado(s) registrado(s)`;

    if (messages.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding: 24px; color: var(--text-dim);">
          <p>Nenhum recado cadastrado para este aluno.</p>
          <small>Utilize o formulário acima para postar a primeira mensagem para a família.</small>
        </div>
      `;
      return;
    }

    const catMeta = {
      recado: { icon: '💬', label: 'Recado', class: 'recado' },
      tarefa: { icon: '📝', label: 'Tarefa', class: 'tarefa' },
      elogio: { icon: '⭐', label: 'Elogio', class: 'elogio' },
      aviso: { icon: '📢', label: 'Aviso', class: 'aviso' },
      desempenho: { icon: '📊', label: 'Desempenho', class: 'desempenho' }
    };

    container.innerHTML = messages.map(msg => {
      const meta = catMeta[msg.category] || catMeta.recado;
      const isImportant = msg.is_important;

      return `
        <div class="agenda-card ${isImportant ? 'important' : ''}" style="margin-bottom: 10px;">
          <div class="agenda-card-header">
            <span class="agenda-cat-badge ${meta.class}">
              <span>${meta.icon}</span>
              <span>${meta.label}</span>
            </span>
            <span class="agenda-date-time-tag">
              🕒 ${msg.formatted_date_time || msg.entry_date_br || ''}
            </span>
          </div>

          <h4 style="font-size: 0.96rem; font-weight: 800; color: var(--brand-blue); margin-bottom: 4px;">${msg.title}</h4>
          <p style="font-size: 0.88rem; color: var(--text-main); margin-bottom: 8px;">${msg.content}</p>

          <div class="agenda-meta-row" style="padding-top: 6px;">
            <span class="text-xs text-muted">Autor: <strong>${msg.author_name || 'Equipe'}</strong></span>
            
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="agenda-read-status ${msg.read_by_parent ? 'read' : 'unread'}">
                ${msg.read_by_parent ? `✓ Lido pelos pais (${msg.read_at_formatted || 'Sim'})` : '⏳ Pendente de leitura'}
              </span>
              <button class="btn-action-sm danger btn-del-agenda-msg" data-msg-id="${msg.id}" title="Excluir recado">
                🗑️
              </button>
            </div>
          </div>

          ${msg.parent_response ? `
            <div class="agenda-reply-bubble" style="margin-top: 8px;">
              <strong>💬 Resposta da Família (${msg.parent_response_at_formatted || ''}):</strong>
              <span>${msg.parent_response}</span>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-del-agenda-msg').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-msg-id');
        await deleteAgendaMessage(id, studentId);
      });
    });

  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger); text-align:center;">${err.message}</p>`;
  }
}

async function handleAddAgendaSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-save-agenda');
  btn.disabled = true;
  btn.innerHTML = '<span>⏳ Publicando...</span>';

  const studentId = document.getElementById('agenda-target-student-id').value;
  const category = document.getElementById('agenda-category').value;
  const title = document.getElementById('agenda-title').value;
  const content = document.getElementById('agenda-content').value;
  const isImportant = document.getElementById('agenda-is-important').checked;

  try {
    const res = await fetch(`${API_BASE}/api/students/${studentId}/agenda`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        category,
        title,
        content,
        is_important: isImportant
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao salvar recado');

    showToast('Recado publicado com sucesso na agenda do aluno!');
    document.getElementById('agenda-title').value = '';
    document.getElementById('agenda-content').value = '';
    document.getElementById('agenda-is-important').checked = false;

    await loadAgendaMessages(studentId);
  } catch (err) {
    showAppAlert(err.message, 'Agenda do Aluno');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>📤 Publicar na Agenda do Aluno</span>';
  }
}

async function deleteAgendaMessage(msgId, studentId) {
  showAppConfirm('Deseja realmente remover este recado da agenda do aluno?', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/agenda/${msgId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (!res.ok) throw new Error('Erro ao excluir recado');
      showToast('Recado removido da agenda!');
      await loadAgendaMessages(studentId);
    } catch (err) {
      showAppAlert(err.message, 'Erro ao Excluir');
    }
  }, 'Excluir Recado', true);
}

let previousStaffView = 'view-students';

function previewParentPortal(studentId) {
  previousStaffView = (state.activeView && state.activeView !== 'view-parent-portal') ? state.activeView : (state.currentUser?.role === 'admin' ? 'view-admin-dashboard' : 'view-students');
  const previewBar = document.getElementById('parent-portal-preview-bar');
  if (previewBar) {
    const student = (state.students || []).find(s => String(s.id) === String(studentId)) || (state.adminStudents || []).find(s => String(s.id) === String(studentId));
    const studentInfo = document.getElementById('preview-student-info');
    if (studentInfo) {
      studentInfo.innerHTML = `<strong>Modo Demonstração Pedagógica:</strong> Visualizando Portal da Família de <strong>${student ? student.name : 'Aluno'}</strong>`;
    }
    previewBar.classList.remove('hidden');
  }
  switchView('view-parent-portal');
  loadParentPortalData(studentId);
  showToast('Visualizando o Portal da Família em modo de demonstração pedagógica.');
}

function exitParentPortalPreview() {
  const previewBar = document.getElementById('parent-portal-preview-bar');
  if (previewBar) previewBar.classList.add('hidden');
  switchView(previousStaffView || (state.currentUser?.role === 'admin' ? 'view-admin-dashboard' : 'view-teacher-today'));
  showToast('Retornou à visão da equipe escolar.');
}
window.previewParentPortal = previewParentPortal;
window.exitParentPortalPreview = exitParentPortalPreview;

function openPendingEnrollmentsModal() {
  openBindTeacherModal();
}
window.openPendingEnrollmentsModal = openPendingEnrollmentsModal;

// =========================================================
// SISTEMA DE DIÁLOGOS IN-APP (ALERT / CONFIRM MODAL)
// =========================================================
function showAppDialog({ title = 'Mensagem', message = '', type = 'info', confirmText = 'OK', cancelText = 'Cancelar', showCancel = false, onConfirm = null }) {
  const modal = document.getElementById('modal-app-dialog');
  if (!modal) {
    if (showCancel) {
      if (confirm(message) && onConfirm) onConfirm();
    } else {
      alert(message);
    }
    return;
  }

  const iconEl = document.getElementById('dialog-icon');
  const iconWrap = document.getElementById('dialog-icon-wrapper');
  const titleEl = document.getElementById('dialog-title');
  const msgEl = document.getElementById('dialog-message');
  const btnConfirm = document.getElementById('dialog-btn-confirm');
  const btnCancel = document.getElementById('dialog-btn-cancel');

  titleEl.textContent = title;
  msgEl.textContent = message;

  iconWrap.className = 'dialog-icon-wrapper ' + type;
  if (type === 'danger') {
    iconEl.textContent = '⚠️';
    btnConfirm.className = 'btn-dialog-confirm danger';
  } else if (type === 'warning') {
    iconEl.textContent = '🔔';
    btnConfirm.className = 'btn-dialog-confirm';
  } else if (type === 'success') {
    iconEl.textContent = '✅';
    btnConfirm.className = 'btn-dialog-confirm';
  } else {
    iconEl.textContent = 'ℹ️';
    btnConfirm.className = 'btn-dialog-confirm';
  }

  btnConfirm.textContent = confirmText;
  btnCancel.textContent = cancelText;

  if (showCancel) {
    btnCancel.style.display = 'block';
  } else {
    btnCancel.style.display = 'none';
  }

  modal.classList.remove('hidden');

  const cleanUp = () => {
    modal.classList.add('hidden');
    btnConfirm.onclick = null;
    btnCancel.onclick = null;
  };

  btnConfirm.onclick = () => {
    cleanUp();
    if (onConfirm) onConfirm();
  };

  btnCancel.onclick = () => {
    cleanUp();
  };
}

function showAppAlert(message, title = 'Aviso') {
  showAppDialog({ title, message, type: 'info', showCancel: false, confirmText: 'Entendi' });
}

function showAppConfirm(message, onConfirm, title = 'Confirmar Ação', isDanger = false) {
  showAppDialog({ 
    title, 
    message, 
    type: isDanger ? 'danger' : 'warning', 
    showCancel: true, 
    confirmText: isDanger ? 'Sim, Confirmar' : 'Confirmar', 
    cancelText: 'Cancelar',
    onConfirm 
  });
}

// =========================================================
// MÓDULO: PAINEL DO ADMINISTRADOR (DASHBOARD & PENDÊNCIAS)
// =========================================================
async function loadAdminDashboard() {
  const pendencyGrid = document.getElementById('admin-pendency-grid');
  if (!pendencyGrid) return;

  pendencyGrid.innerHTML = '<div class="pendency-skeleton" style="padding:16px; text-align:center;">Carregando pendências e métricas...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/admin/dashboard`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Falha ao carregar métricas do painel');
    const data = await res.json();
    renderAdminDashboard(data);
    appendAdminFamilyAlerts();
  } catch (err) {
    pendencyGrid.innerHTML = `<p style="color:var(--danger); text-align:center; padding:16px;">${err.message}</p>`;
  }
}

function renderAdminDashboard(data) {
  const kpis = data.kpis || {};
  const pending = data.pending || {};

  // Atualiza KPIs
  const elStudents = document.getElementById('admin-kpi-students');
  const elTeachers = document.getElementById('admin-kpi-teachers');
  const elSubjects = document.getElementById('admin-kpi-subjects');
  const elMonth = document.getElementById('admin-kpi-month-classes');
  const elRate = document.getElementById('admin-kpi-attendance-rate');

  if (elStudents) elStudents.textContent = kpis.total_students || 0;
  if (elTeachers) elTeachers.textContent = kpis.total_teachers || 0;
  if (elSubjects) elSubjects.textContent = kpis.total_subjects || 0;
  if (elMonth) elMonth.textContent = kpis.month_classes || 0;
  if (elRate) elRate.textContent = (kpis.avg_attendance_rate !== null ? kpis.avg_attendance_rate + '%' : '—');

  // Renderiza Pendências
  const grid = document.getElementById('admin-pendency-grid');
  if (!grid) return;

  let pendencyHtml = '';

  const unassigned = pending.students_without_teacher || [];
  const unread3d = pending.unread_agenda_3d || [];
  const lowAtt = pending.low_attendance_students || [];
  const inactiveTeachers = pending.inactive_teachers || [];

  let hasPending = false;

  // 1. Alunos aguardando professor
  if (unassigned.length > 0) {
    hasPending = true;
    const namesPreview = unassigned.slice(0, 3).map(s => s.name).join(', ') + (unassigned.length > 3 ? ` (+${unassigned.length - 3})` : '');
    pendencyHtml += `
      <div class="pendency-card">
        <div class="pendency-info">
          <span class="pendency-icon">⏳</span>
          <div class="pendency-text">
            <strong>${unassigned.length} aluno(s) aguardando professor</strong>
            <small>Matrículas sem docente: <span style="color:var(--brand-blue); font-weight:600;">${namesPreview}</span></small>
          </div>
        </div>
        <button class="pendency-btn" onclick="openPendingEnrollmentsModal()">
          Atribuir Agora ➔
        </button>
      </div>
    `;
  }

  // 2. Recados pendentes de leitura (+3 dias)
  if (unread3d.length > 0) {
    hasPending = true;
    const namesPreview = unread3d.slice(0, 3).map(s => `${s.student_name} (${s.days_pending}d)`).join(', ') + (unread3d.length > 3 ? ` (+${unread3d.length - 3})` : '');
    pendencyHtml += `
      <div class="pendency-card danger">
        <div class="pendency-info">
          <span class="pendency-icon">📨</span>
          <div class="pendency-text">
            <strong>${unread3d.length} recado(s) sem confirmação de leitura (+3 dias)</strong>
            <small>Avisos pendentes: <span style="color:var(--danger); font-weight:600;">${namesPreview}</span></small>
          </div>
        </div>
        <button class="pendency-btn danger" onclick="switchView('view-students')">
          Ver Alunos & Avisos ➔
        </button>
      </div>
    `;
  }

  // 3. Alunos com frequência < 75%
  if (lowAtt.length > 0) {
    hasPending = true;
    const namesPreview = lowAtt.slice(0, 3).map(s => `${s.name} (${s.rate}%)`).join(', ') + (lowAtt.length > 3 ? ` (+${lowAtt.length - 3})` : '');
    pendencyHtml += `
      <div class="pendency-card danger">
        <div class="pendency-info">
          <span class="pendency-icon">📉</span>
          <div class="pendency-text">
            <strong>${lowAtt.length} aluno(s) com frequência abaixo de 75%</strong>
            <small>Atenção especial: <span style="color:var(--danger); font-weight:600;">${namesPreview}</span></small>
          </div>
        </div>
        <button class="pendency-btn danger" onclick="switchView('view-reports')">
          Ver Relatórios ➔
        </button>
      </div>
    `;
  }

  // 4. Professores sem lançamentos (+7 dias)
  if (inactiveTeachers.length > 0) {
    hasPending = true;
    const namesPreview = inactiveTeachers.slice(0, 3).map(t => `${t.name} (${t.days_since_last_class ? t.days_since_last_class + 'd' : 'sem aulas'})`).join(', ') + (inactiveTeachers.length > 3 ? ` (+${inactiveTeachers.length - 3})` : '');
    pendencyHtml += `
      <div class="pendency-card">
        <div class="pendency-info">
          <span class="pendency-icon">⚠️</span>
          <div class="pendency-text">
            <strong>${inactiveTeachers.length} professor(es) sem aulas registradas nos últimos 7 dias</strong>
            <small>Docentes sem diário: <span style="color:var(--brand-orange); font-weight:600;">${namesPreview}</span></small>
          </div>
        </div>
        <button class="pendency-btn" onclick="switchView('view-admin')">
          Ver Professores ➔
        </button>
      </div>
    `;
  }

  if (!hasPending) {
    pendencyHtml = `
      <div class="pendency-card success-none">
        <div class="pendency-info">
          <span class="pendency-icon">🎉</span>
          <div class="pendency-text">
            <strong>Tudo em dia na Entrelinhas!</strong>
            <small>Nenhuma pendência crítica de matrículas, diários ou comunicados no momento.</small>
          </div>
        </div>
      </div>
    `;
  }

  grid.innerHTML = pendencyHtml;

  // Setup click listeners on Shortcuts
  const btnNewSt = document.getElementById('btn-quick-new-student');
  if (btnNewSt) btnNewSt.onclick = () => openStudentModalAdmin(null);

  const btnNewTeach = document.getElementById('btn-quick-new-teacher');
  if (btnNewTeach) btnNewTeach.onclick = () => openTeacherModal(null);

  const btnNewSub = document.getElementById('btn-quick-new-subject');
  if (btnNewSub) btnNewSub.onclick = () => openSubjectModalAdmin(null);

  const btnOpenSched = document.getElementById('btn-quick-open-schedule');
  if (btnOpenSched) btnOpenSched.onclick = () => switchView('view-schedules');

  const btnOpenRep = document.getElementById('btn-quick-open-reports');
  if (btnOpenRep) btnOpenRep.onclick = () => switchView('view-reports');
}

// =========================================================
// MÓDULO: TELA "HOJE" DO PROFESSOR (AULAS DO DIA)
// =========================================================
async function loadTeacherTodayClasses() {
  const container = document.getElementById('teacher-today-list');
  if (!container) return;

  container.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';

  try {
    const res = await fetch(`${API_BASE}/api/teacher/today-classes`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Erro ao carregar aulas de hoje');
    const data = await res.json();
    renderTeacherTodayClasses(data);
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger); text-align:center; padding:20px;">${err.message}</p>`;
  }
}

function renderTeacherTodayClasses(data) {
  const user = state.currentUser;
  const greetingEl = document.getElementById('teacher-today-greeting');
  const dateTextEl = document.getElementById('teacher-today-date-text');
  const pillTotal = document.getElementById('today-pill-total');
  const pillPending = document.getElementById('today-pill-pending');
  const pillDone = document.getElementById('today-pill-done');
  const tomorrowCountEl = document.getElementById('teacher-tomorrow-count');
  const container = document.getElementById('teacher-today-list');

  if (greetingEl) {
    greetingEl.textContent = `Olá, ${user ? user.name.split(' ')[0] : 'Professor(a)'}!`;
  }
  if (dateTextEl) {
    dateTextEl.textContent = `${data.day_name || 'Hoje'}, ${data.date_br || ''}`;
  }
  if (pillTotal) pillTotal.textContent = `${data.total_today || 0} aula(s) hoje`;
  if (pillPending) pillPending.textContent = `${data.pending_count || 0} pendente(s)`;
  if (pillDone) pillDone.textContent = `${data.registered_count || 0} registrada(s)`;
  if (tomorrowCountEl) tomorrowCountEl.textContent = data.tomorrow_count || 0;

  const btnMySchedule = document.getElementById('btn-go-to-my-schedule');
  if (btnMySchedule) {
    btnMySchedule.onclick = () => switchView('view-schedules');
  }

  const classes = data.classes || [];

  if (classes.length === 0) {
    container.innerHTML = `
      <div style="background:#fff; border:1px dashed var(--border-color); border-radius:var(--radius-md); padding:36px 20px; text-align:center;">
        <span style="font-size:2.5rem; display:block; margin-bottom:10px;">☕</span>
        <h4 style="font-size:1.1rem; font-weight:800; color:var(--text-main); margin-bottom:4px;">Nenhuma aula agendada para hoje!</h4>
        <p class="text-sm text-muted" style="max-width:400px; margin:0 auto 16px auto;">
          Aproveite para revisar os lançamentos anteriores no <strong>Meu Diário</strong> ou consultar a <strong>Minha Grade</strong>.
        </p>
        <button class="btn-primary-action" onclick="switchView('view-schedules')" style="margin:0 auto;">
          <span>📅 Abrir Minha Grade</span>
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = classes.map(c => {
    const isDone = c.status === 'registrado' || c.status === 'registered';
    const statusCls = isDone ? 'registered' : 'pending';
    return `
      <div class="today-class-card ${statusCls} ${c.status}" data-schedule-id="${c.schedule_id}">
        <div class="today-card-top">
          <span class="today-time-badge">🕒 ${c.time_display}</span>
          <span class="today-status-badge ${statusCls} ${c.status}">
            ${isDone ? '✅ Diário Registrado' : '⚠️ Pendente de Diário'}
          </span>
        </div>

        <div class="today-card-body">
          <div class="today-student-avatar">🎓</div>
          <div class="today-student-meta">
            <strong>${c.student_name}</strong>
            <small>${c.student_objective_grade || 'Diário de Classe'} • 📍 ${c.room_or_info}</small>
            <span class="today-subject-badge">📚 ${c.subject_name}</span>
          </div>
        </div>

        <div class="today-card-footer" style="display:flex; gap:8px;">
          ${!isDone ? `
            <button class="btn-today-log" onclick="openClassEntryModal('${c.student_id}', '${c.subject_id || ''}', '${data.date_str}', '${c.start_time}')">
              <span>✏️ Registrar Diário Desta Aula</span>
            </button>
          ` : `
            <button class="btn-today-view" style="flex:1;" onclick="openStudentHistoryModal('${c.student_id}')">
              <span>👁️ Ver Histórico Completo</span>
            </button>
            ${c.log_id ? `
              <button class="btn-today-log" style="background:#f8fafc; border:1px solid #cbd5e1; color:var(--text-main); padding:6px 12px;" onclick="editLogEntry('${c.log_id}')" title="Editar o registro de hoje">
                <span>✏️ Editar</span>
              </button>
            ` : ''}
          `}
        </div>
      </div>
    `;
  }).join('');
}

// =========================================================
// AÇÕES DO DIÁRIO DE AULA (EDIÇÃO E EXCLUSÃO)
// =========================================================
async function editLogEntry(logId) {
  try {
    let log = null;
    if (state.historyLogs) log = state.historyLogs.find(l => String(l.id) === String(logId));
    if (!log && state.currentStudentReport && state.currentStudentReport.logs) {
      log = state.currentStudentReport.logs.find(l => String(l.id) === String(logId));
    }
    if (!log) {
      const res = await fetch(`${API_BASE}/api/logs?limit=100`, { headers: getAuthHeaders() });
      if (res.ok) {
        const logs = await res.json();
        log = logs.find(l => String(l.id) === String(logId));
      }
    }
    if (!log) {
      showAppAlert('Registro não localizado para edição.', 'Editar Diário');
      return;
    }
    await openClassEntryModal(log.student_id, log.subject_id, log.class_date, log.class_time, log);
  } catch (err) {
    showAppAlert('Erro ao abrir diário para edição: ' + err.message, 'Editar Diário');
  }
}

async function deleteLogEntry(logId) {
  showAppConfirm(
    'Tem certeza de que deseja excluir este registro de aula? Esta ação não pode ser desfeita.',
    async () => {
      try {
        const res = await fetch(`${API_BASE}/api/logs/${logId}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Erro ao excluir aula');
        }
        showToast('Registro de aula excluído com sucesso.');
        loadStudents();
        loadStats();
        if (state.activeView === 'view-history') loadGeneralHistory();
        if (state.activeView === 'view-teacher-today') loadTeacherTodayClasses();
        if (state.activeView === 'view-admin-dashboard') loadAdminDashboardData();
        if (state.activeView === 'view-reports' && state.selectedReportStudentId) {
          loadStudentReport(state.selectedReportStudentId);
        }
      } catch (err) {
        showAppAlert('Erro ao excluir: ' + err.message, 'Excluir Diário');
      }
    },
    'Excluir Diário',
    true
  );
}

// Aliases globais defensivos para atalhos
window.openStudentModal = () => openStudentModalAdmin(null);
window.openSubjectModal = () => openSubjectModalAdmin(null);
window.editLogEntry = editLogEntry;
window.deleteLogEntry = deleteLogEntry;

// =========================================================================
// 🌐 PORTAL EDUCACIONAL ENTRELINHAS: SITE, LMS & FINANCEIRO
// =========================================================================

function setupWebsiteEvents() {
  const btnWebLogin = document.getElementById('btn-website-open-login');
  const btnHeroLogin = document.getElementById('btn-hero-login');
  const btnBackWeb = document.getElementById('btn-back-to-website');
  const btnHeaderWeb = document.getElementById('btn-header-website');

  if (btnWebLogin) {
    btnWebLogin.addEventListener('click', () => showLogin('parent'));
  }
  if (btnHeroLogin) {
    btnHeroLogin.addEventListener('click', () => showLogin('parent'));
  }
  if (btnBackWeb) {
    btnBackWeb.addEventListener('click', () => showWebsite());
  }
  if (btnHeaderWeb) {
    btnHeaderWeb.addEventListener('click', () => showWebsite());
  }

  // Links do rodapé para as áreas do sistema
  const footerParent = document.getElementById('link-footer-parent');
  const footerTeacher = document.getElementById('link-footer-teacher');
  const footerAdmin = document.getElementById('link-footer-admin');
  if (footerParent) footerParent.addEventListener('click', () => showLogin('parent'));
  if (footerTeacher) footerTeacher.addEventListener('click', () => showLogin('school'));
  if (footerAdmin) footerAdmin.addEventListener('click', () => showLogin('school'));

  // Menu do site no celular
  const wsNav = document.getElementById('ws-nav');
  const wsToggle = document.getElementById('ws-menu-toggle');
  const closeWsMenu = () => {
    if (!wsNav) return;
    wsNav.classList.remove('is-open');
    if (wsToggle) wsToggle.setAttribute('aria-expanded', 'false');
  };
  if (wsToggle && wsNav) {
    wsToggle.addEventListener('click', () => {
      const open = wsNav.classList.toggle('is-open');
      wsToggle.setAttribute('aria-expanded', String(open));
    });
    document.querySelectorAll('#ws-links a').forEach(a => a.addEventListener('click', closeWsMenu));
  }

  // Navbar ganha fundo ao rolar
  if (wsNav) {
    const onScroll = () => wsNav.classList.toggle('is-scrolled', window.scrollY > 12);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // Destaca no menu a seção visível
  if ('IntersectionObserver' in window) {
    const links = Array.from(document.querySelectorAll('#ws-links .site-nav-link'));
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        links.forEach(l => l.classList.toggle('active', l.getAttribute('href') === `#${entry.target.id}`));
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    links.forEach(l => {
      const target = document.querySelector(l.getAttribute('href'));
      if (target) observer.observe(target);
    });
  }

  // Rolagem suave no site institucional
  document.querySelectorAll('#view-website a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href').substring(1);
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        e.preventDefault();
        targetEl.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  // Formulário de captação de leads da landing page
  const formLead = document.getElementById('form-website-lead');
  if (formLead) {
    formLead.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-submit-lead');
      const origText = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>⏳ Enviando solicitação...</span>';
      }

      try {
        const payload = {
          name: document.getElementById('lead-name').value.trim(),
          phone: document.getElementById('lead-phone').value.trim(),
          email: document.getElementById('lead-email')?.value.trim() || null,
          course_interest: document.getElementById('lead-course').value,
          student_grade: document.getElementById('lead-grade')?.value.trim() || null,
          message: document.getElementById('lead-message')?.value.trim() || null
        };

        const res = await fetch(`${API_BASE}/api/leads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao enviar contato');

        showToast('🎉 Solicitação recebida! Nossa coordenação entrará em contato em breve.');
        formLead.reset();
      } catch (err) {
        showAppAlert(err.message, 'Agendamento de Aula');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = origText;
        }
      }
    });
  }
}

function setupEducationalPortalEvents() {
  // Modal Pix
  const btnClosePix = document.getElementById('btn-close-pix-modal');
  const btnDonePix = document.getElementById('btn-done-pix');
  const btnCopyPix = document.getElementById('btn-copy-pix-code');
  if (btnClosePix) btnClosePix.addEventListener('click', closePixModal);
  if (btnDonePix) {
    btnDonePix.addEventListener('click', () => {
      closePixModal();
      showToast('Obrigado! O pagamento Pix é processado automaticamente.');
    });
  }
  if (btnCopyPix) {
    btnCopyPix.addEventListener('click', () => {
      const copyInput = document.getElementById('pix-copy-paste-input');
      if (copyInput) {
        copyInput.select();
        navigator.clipboard.writeText(copyInput.value).then(() => {
          showToast('Código Pix copiado para a área de transferência! Cole no app do seu banco.');
        }).catch(() => {
          document.execCommand('copy');
          showToast('Código Pix copiado!');
        });
      }
    });
  }

  // Modal Nova Fatura (Admin)
  const btnAdminNewInvoice = document.getElementById('btn-admin-new-invoice');
  const btnCloseInvoice = document.getElementById('btn-close-invoice-modal');
  const formInvoice = document.getElementById('form-new-invoice');
  if (btnAdminNewInvoice) btnAdminNewInvoice.addEventListener('click', openNewInvoiceModal);
  if (btnCloseInvoice) btnCloseInvoice.addEventListener('click', closeNewInvoiceModal);
  if (formInvoice) {
    formInvoice.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const payload = {
          student_id: parseInt(document.getElementById('inv-student-id').value),
          plan_id: document.getElementById('inv-plan')?.value ? parseInt(document.getElementById('inv-plan').value) : null,
          title: document.getElementById('inv-title').value.trim(),
          amount: parseFloat(document.getElementById('inv-amount').value),
          discount: parseFloat(document.getElementById('inv-discount').value || 0),
          due_date: document.getElementById('inv-due-date').value,
          payment_method: document.getElementById('inv-method').value,
          notes: document.getElementById('inv-notes')?.value.trim() || null
        };
        const res = await fetch(`${API_BASE}/api/financial/invoices`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao gerar fatura');
        showToast('Fatura gerada com sucesso! Código Pix emitido.');
        closeNewInvoiceModal();
        loadAdminFinancialDashboard();
      } catch (err) {
        showAppAlert(err.message, 'Gerar Fatura');
      }
    });
  }

  // Filtros de status do financeiro admin
  document.querySelectorAll('#admin-finance-status-filters .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#admin-finance-status-filters .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      filterAdminInvoices(pill.getAttribute('data-status'));
    });
  });

  // Busca do financeiro admin
  const finSearch = document.getElementById('admin-finance-search');
  if (finSearch) {
    let timeout;
    finSearch.addEventListener('input', () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        filterAdminInvoices();
      }, 300);
    });
  }

  // Modal Envio de Atividade / Redação (Aluno)
  const btnCloseSubmitAssign = document.getElementById('btn-close-submit-assign');
  const formSubmitAssign = document.getElementById('form-submit-assignment');
  if (btnCloseSubmitAssign) btnCloseSubmitAssign.addEventListener('click', closeSubmitAssignmentModal);
  if (formSubmitAssign) {
    formSubmitAssign.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('submit-assign-id').value;
      const text = document.getElementById('submit-assign-text').value.trim();
      const url = document.getElementById('submit-assign-url')?.value.trim() || null;
      try {
        const res = await fetch(`${API_BASE}/api/assignments/${id}/submit`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ submission_text: text, submission_attachment_url: url })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao enviar atividade');
        showToast('🚀 Atividade enviada com sucesso! O professor fará a correção.');
        closeSubmitAssignmentModal();
        loadStudentOnlineClasses();
      } catch (err) {
        showAppAlert(err.message, 'Envio de Atividade');
      }
    });
  }

  // Modal Correção de Atividade (Professor / Admin)
  const btnCloseGradeAssign = document.getElementById('btn-close-grade-assign');
  const formGradeAssign = document.getElementById('form-grade-assignment');
  if (btnCloseGradeAssign) btnCloseGradeAssign.addEventListener('click', closeGradeAssignmentModal);
  if (formGradeAssign) {
    formGradeAssign.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('grade-assign-id').value;
      const grade = parseFloat(document.getElementById('grade-assign-val').value);
      const feedback = document.getElementById('grade-assign-feedback').value.trim();
      try {
        const res = await fetch(`${API_BASE}/api/assignments/${id}/grade`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ grade, teacher_feedback: feedback })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar avaliação');
        showToast('✓ Avaliação e feedback salvos com sucesso!');
        closeGradeAssignmentModal();
        if (state.activeView === 'view-assignments') loadAssignmentsView();
        if (state.activeView === 'view-admin-courses') loadAdminCourses();
        if (state.activeView === 'view-parent-portal') loadStudentOnlineClasses();
      } catch (err) {
        showAppAlert(err.message, 'Avaliação Pedagógica');
      }
    });
  }
}

// ==========================================
// 1. SITE INSTITUCIONAL & CATÁLOGO
// ==========================================
async function loadWebsiteCourses() {
  const grid = document.getElementById('website-courses-grid');
  const leadSelect = document.getElementById('lead-course');
  if (!grid) return;

  try {
    const res = await fetch(`${API_BASE}/api/courses`);
    if (!res.ok) throw new Error('Falha ao carregar cursos');
    const courses = await res.json();
    state.websiteCourses = courses;

    if (courses.length === 0) {
      grid.innerHTML = '<div class="text-center text-muted py-4">Nenhum curso disponível no momento.</div>';
      return;
    }

    if (leadSelect) {
      const currentVal = leadSelect.value;
      leadSelect.innerHTML = '<option value="">Selecione...</option>' +
        courses.map(c => `<option value="${c.title}">${c.title}</option>`).join('') +
        '<option value="Acompanhamento Pedagógico Geral">Acompanhamento Pedagógico Geral</option>';
      if (currentVal) leadSelect.value = currentVal;
    }

    const MODALITY = { hibrido: 'Presencial + online', presencial: 'Presencial', online: 'Online' };
    const THEME = { concurso: 'ws-c-blue', concursos: 'ws-c-blue', redacao: 'ws-c-orange', reforco: 'ws-c-green', informatica: 'ws-c-sky' };
    grid.innerHTML = courses.map(c => {
      const priceNum = parseFloat(c.price || 0);
      const lessons = parseInt(c.total_lessons) || 0;
      const meta = [
        MODALITY[c.modality] || null,
        c.workload_hours ? `${parseInt(c.workload_hours)}h de carga horária` : null,
        lessons > 0 ? `${lessons} aula${lessons > 1 ? 's' : ''} gravada${lessons > 1 ? 's' : ''}` : null
      ].filter(Boolean);
      return `
        <article class="ws-course ${THEME[c.category] || 'ws-c-blue'}" data-course-id="${c.id}">
          <div class="ws-course-top">
            <span class="ws-course-icon">${escapeHtml(c.icon || '📚')}</span>
            ${c.badge ? `<span class="ws-course-badge">${escapeHtml(c.badge)}</span>` : ''}
          </div>
          <h3 class="ws-course-title">${escapeHtml(c.title)}</h3>
          <p class="ws-course-desc">${escapeHtml(c.headline || c.description || '')}</p>
          <ul class="ws-course-meta">
            ${meta.map(m => `<li>${escapeHtml(m)}</li>`).join('')}
          </ul>
          <div class="ws-course-foot">
            <div class="ws-course-price">
              ${priceNum > 0
                ? `<small>a partir de</small><strong>R$ ${priceNum.toFixed(2).replace('.', ',')}</strong><small>/mês</small>`
                : '<strong>Consulte</strong>'}
            </div>
            <button type="button" class="ws-btn ws-btn-dark" onclick="enrollCourseInquiry('${encodeURIComponent(c.title)}')">Quero este</button>
          </div>
        </article>
      `;
    }).join('');
  } catch (err) {
    console.warn('Erro ao carregar cursos:', err);
  }
}

function enrollCourseInquiry(courseTitle) {
  const title = decodeURIComponent(courseTitle);
  const contactSec = document.getElementById('site-contato');
  const select = document.getElementById('lead-course');
  const nameInput = document.getElementById('lead-name');
  if (select) {
    select.value = title;
  }
  if (contactSec) {
    contactSec.scrollIntoView({ behavior: 'smooth' });
  }
  if (nameInput) {
    setTimeout(() => nameInput.focus(), 500);
  }
}

// ==========================================
// 2. LMS & AMBIENTE DE AULAS ONLINE (ALUNO)
// ==========================================
async function loadStudentOnlineClasses() {
  const liveBanner = document.getElementById('student-live-banner');
  const liveTitle = document.getElementById('student-live-title');
  const liveDesc = document.getElementById('student-live-desc');
  const liveTeacher = document.getElementById('student-live-teacher');
  const liveTime = document.getElementById('student-live-time');
  const liveRoom = document.getElementById('student-live-room');
  const btnLive = document.getElementById('btn-student-enter-live');
  const coursesContainer = document.getElementById('student-courses-list');
  const assignmentsContainer = document.getElementById('student-assignments-list');

  // 1. Próxima aula do aluno (calculada pela recorrência real da grade)
  try {
    const resLive = await fetch(`${API_BASE}/api/student/live-classes`, { headers: getAuthHeaders() });
    const liveData = resLive.ok ? await resLive.json() : null;
    const next = liveData ? findNextStudentClass(liveData.schedules || []) : null;
    if (liveBanner) liveBanner.classList.toggle('hidden', !next);
    if (next) {
      const s = next.sched;
      const isOnline = s.classroom_type === 'online';
      const badge = liveBanner.querySelector('.live-badge-pulse');
      if (badge) badge.textContent = isOnline ? '🔴 AULA ONLINE' : '📅 PRÓXIMA AULA';
      const freqLabel = s.frequency_type === 'quinzenal' ? 'Quinzenal'
        : s.frequency_type === 'custom_dias' ? `A cada ${s.recurrence_interval_days || 3} dias` : 'Semanal';
      if (liveTitle) liveTitle.textContent = s.subject_name || 'Próxima aula';
      if (liveDesc) liveDesc.textContent = `${next.label} · ${s.start_time} às ${s.end_time}`;
      if (liveTeacher) liveTeacher.textContent = `👨‍🏫 ${s.teacher_name}`;
      if (liveTime) liveTime.textContent = `🔁 ${freqLabel}`;
      if (liveRoom) liveRoom.textContent = `📍 ${s.classroom_name || (isOnline ? 'Sala virtual' : 'Presencial')}`;
      if (btnLive) {
        // Só mostra o botão quando a sala virtual tem link cadastrado
        const hasLink = Boolean(s.live_meeting_url);
        btnLive.classList.toggle('hidden', !hasLink);
        if (hasLink) btnLive.href = s.live_meeting_url;
      }
    }
  } catch (e) {
    console.warn('Erro ao carregar a próxima aula:', e);
    if (liveBanner) liveBanner.classList.add('hidden');
  }

  // 2. Cursos e Videoaulas Gravadas
  try {
    if (coursesContainer) coursesContainer.innerHTML = '<div class="loading-state">Carregando aulas e módulos...</div>';
    const resCourses = await fetch(`${API_BASE}/api/courses`, { headers: getAuthHeaders() });
    if (resCourses.ok) {
      const courses = await resCourses.json();
      if (courses.length === 0) {
        if (coursesContainer) coursesContainer.innerHTML = '<div class="text-center text-muted py-3">Nenhum curso matriculado no momento.</div>';
      } else {
        const detailedCourses = await Promise.all(courses.map(async (c) => {
          try {
            const r = await fetch(`${API_BASE}/api/courses/${c.id}`, { headers: getAuthHeaders() });
            return r.ok ? await r.json() : c;
          } catch (err) {
            return c;
          }
        }));

        if (coursesContainer) {
          coursesContainer.innerHTML = detailedCourses.map(c => renderStudentCourseCard(c)).join('');
        }
      }
    }
  } catch (e) {
    if (coursesContainer) coursesContainer.innerHTML = '<div class="text-danger py-2">Erro ao carregar cursos online.</div>';
  }

  // 3. Atividades & Redações
  try {
    if (assignmentsContainer) assignmentsContainer.innerHTML = '<div class="loading-state">Carregando atividades...</div>';
    const resAssign = await fetch(`${API_BASE}/api/assignments`, { headers: getAuthHeaders() });
    if (resAssign.ok) {
      const assignments = await resAssign.json();
      if (assignments.length === 0) {
        if (assignmentsContainer) assignmentsContainer.innerHTML = '<div class="text-center text-muted py-3">Nenhuma redação ou tarefa pendente.</div>';
      } else {
        if (assignmentsContainer) {
          assignmentsContainer.innerHTML = assignments.map(a => renderStudentAssignmentCard(a)).join('');
        }
      }
    }
  } catch (e) {
    if (assignmentsContainer) assignmentsContainer.innerHTML = '<div class="text-danger py-2">Erro ao carregar atividades.</div>';
  }
}

function renderStudentCourseCard(course) {
  const modules = course.modules || [];
  let totalLessons = 0;
  let completedLessons = 0;

  modules.forEach(m => {
    (m.lessons || []).forEach(l => {
      totalLessons++;
      if (l.completed) completedLessons++;
    });
  });

  const progressPct = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

  return `
    <div class="student-course-item-card" style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; margin-bottom:16px; overflow:hidden;">
      <div style="padding:16px 20px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div>
          <h4 style="margin:0 0 4px 0; color:var(--text-main); font-size:1.1rem; font-weight:800;">${course.title}</h4>
          <span class="text-sm text-muted">Progresso: ${completedLessons} de ${totalLessons} aulas concluídas</span>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="width:120px; height:8px; background:#e2e8f0; border-radius:4px; overflow:hidden;">
            <div style="width:${progressPct}%; height:100%; background:var(--brand-orange); transition:width 0.3s;"></div>
          </div>
          <strong style="color:var(--brand-orange); font-size:0.9rem;">${progressPct}%</strong>
        </div>
      </div>

      <div style="padding:12px 20px;">
        ${modules.map(mod => `
          <div class="course-module-group" style="margin-bottom:14px;">
            <h5 style="margin:8px 0; font-size:0.95rem; color:#334155; font-weight:700;">📂 ${mod.title}</h5>
            <div class="module-lessons-list" style="display:flex; flex-direction:column; gap:8px;">
              ${(mod.lessons || []).map(lesson => `
                <div class="lesson-row" style="display:flex; align-items:center; justify-content:space-between; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px 14px; gap:10px;">
                  <div style="display:flex; align-items:center; gap:10px; flex:1;">
                    <button type="button" class="btn-check-lesson" onclick="toggleLessonProgress(${lesson.id}, ${!lesson.completed})" style="background:none; border:none; cursor:pointer; font-size:1.2rem; padding:0;" title="${lesson.completed ? 'Marcar como não concluída' : 'Marcar como concluída'}">
                      ${lesson.completed ? '✅' : '⚪'}
                    </button>
                    <div>
                      <strong style="font-size:0.9rem; color:var(--text-main); display:block;">${lesson.title}</strong>
                      <span class="text-xs text-muted">⏱️ ${lesson.duration_minutes || 45} min ${lesson.is_live ? '• 🔴 Aula Ao Vivo' : '• 🎬 Gravada'}</span>
                    </div>
                  </div>

                  <div style="display:flex; align-items:center; gap:8px;">
                    ${lesson.materials_url ? `
                      <a href="${lesson.materials_url}" target="_blank" rel="noopener" class="btn-sm-action" style="background:#e0f2fe; color:#0284c7; padding:5px 10px; border-radius:6px; font-size:0.8rem; font-weight:700; text-decoration:none;">
                        📄 PDF
                      </a>
                    ` : ''}
                    <button type="button" class="btn-sm-action" onclick="openLessonVideoModal('${encodeURIComponent(lesson.video_url || '')}', '${encodeURIComponent(lesson.title)}')" style="background:var(--brand-blue); color:#fff; padding:5px 12px; border-radius:6px; font-size:0.8rem; font-weight:700; border:none; cursor:pointer;">
                      ▶ Assistir
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderStudentAssignmentCard(a) {
  const isGraded = a.status === 'corrigido' && a.grade !== null;
  const isSubmitted = a.status === 'enviado';
  const statusBadge = isGraded 
    ? `<span style="background:#dcfce7; color:#16a34a; font-weight:800; padding:4px 8px; border-radius:6px; font-size:0.8rem;">Nota: ${parseFloat(a.grade).toFixed(1)}/10</span>`
    : isSubmitted 
      ? `<span style="background:#fef3c7; color:#d97706; font-weight:800; padding:4px 8px; border-radius:6px; font-size:0.8rem;">⏳ Em Correção</span>`
      : `<span style="background:#fee2e2; color:#dc2626; font-weight:800; padding:4px 8px; border-radius:6px; font-size:0.8rem;">⚠️ Pendente de Envio</span>`;

  return `
    <div class="assignment-card" style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; gap:8px;">
        <div>
          <span style="font-size:0.75rem; color:#64748b; font-weight:700; text-transform:uppercase;">${a.course_title || 'Atividade'}</span>
          <h4 style="margin:2px 0 4px 0; color:var(--text-main); font-size:1rem; font-weight:800;">${a.title}</h4>
        </div>
        <div>${statusBadge}</div>
      </div>
      <p style="margin:0 0 10px 0; color:#475569; font-size:0.85rem;">${a.instructions || a.description || ''}</p>
      
      ${isGraded ? `
        <div style="background:#f0fdf4; border-left:4px solid #16a34a; padding:10px 14px; border-radius:6px; margin-bottom:10px;">
          <strong style="color:#15803d; font-size:0.85rem; display:block;">Feedback do Professor:</strong>
          <p style="margin:4px 0 0 0; color:#166534; font-size:0.85rem;">${a.teacher_feedback || 'Excelente desempenho na resolução.'}</p>
        </div>
      ` : ''}

      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; padding-top:8px; border-top:1px solid #f1f5f9;">
        <span class="text-xs text-muted">Vencimento: ${formatDateBR(a.due_date)}</span>
        ${!isGraded ? `
          <button type="button" onclick="openSubmitAssignmentModal(${a.id}, '${encodeURIComponent(a.title)}')" style="background:var(--brand-orange); color:#fff; border:none; padding:6px 14px; border-radius:6px; font-weight:700; font-size:0.85rem; cursor:pointer;">
            ${isSubmitted ? '✏️ Reenviar Redação' : '🚀 Enviar Produção'}
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

async function toggleLessonProgress(lessonId, completed) {
  try {
    const res = await fetch(`${API_BASE}/api/lessons/${lessonId}/progress`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ completed })
    });
    if (!res.ok) throw new Error('Falha ao atualizar progresso');
    showToast(completed ? '✅ Aula marcada como concluída!' : 'Aula desmarcada');
    loadStudentOnlineClasses();
  } catch (err) {
    showAppAlert(err.message, 'Progresso');
  }
}

function openLessonVideoModal(videoUrlEncoded, titleEncoded) {
  const url = decodeURIComponent(videoUrlEncoded);
  const title = decodeURIComponent(titleEncoded);
  if (!url) {
    showAppAlert('O link da gravação desta aula estará disponível em breve.', title);
    return;
  }
  window.open(url, '_blank');
}

function openSubmitAssignmentModal(assignmentId, titleEncoded) {
  const modal = document.getElementById('modal-submit-assignment');
  const titleEl = document.getElementById('modal-submit-assign-title');
  const idInput = document.getElementById('submit-assign-id');
  if (idInput) idInput.value = assignmentId;
  if (titleEl) titleEl.textContent = titleEncoded ? decodeURIComponent(titleEncoded) : 'Enviar Atividade';
  if (modal) modal.classList.remove('hidden');
}

function closeSubmitAssignmentModal() {
  const modal = document.getElementById('modal-submit-assignment');
  if (modal) modal.classList.add('hidden');
}

function openGradeAssignmentModal(assignmentId) {
  const modal = document.getElementById('modal-grade-assignment');
  const idInput = document.getElementById('grade-assign-id');
  if (idInput) idInput.value = assignmentId;
  const a = (state.assignments || []).find(x => x.id === assignmentId);
  const preview = document.getElementById('grade-assign-preview');
  const titleEl = document.getElementById('modal-grade-title');
  if (titleEl) titleEl.textContent = a ? `Correção: ${a.title}` : 'Correção Pedagógica';
  if (preview) {
    preview.innerHTML = a ? `
      <p style="margin:0 0 6px;"><strong>${escapeHtml(a.student_name)}</strong>${a.formatted_submitted_at ? ' · enviado em ' + a.formatted_submitted_at : ''}</p>
      <div style="white-space:pre-wrap; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px; max-height:240px; overflow:auto; font-size:0.9rem;">${escapeHtml(a.submission_text || '(sem texto)')}</div>
      ${a.attachment_url ? `<p style="margin:6px 0 0;"><a href="${escapeHtml(a.attachment_url)}" target="_blank" rel="noopener">📎 Abrir anexo</a></p>` : ''}
    ` : '';
  }
  const gradeInput = document.getElementById('grade-assign-val');
  const feedbackInput = document.getElementById('grade-assign-feedback');
  if (gradeInput) gradeInput.value = a && a.grade !== null && a.grade !== undefined ? a.grade : '';
  if (feedbackInput) feedbackInput.value = a && a.teacher_feedback ? a.teacher_feedback : '';
  if (modal) modal.classList.remove('hidden');
}

function closeGradeAssignmentModal() {
  const modal = document.getElementById('modal-grade-assignment');
  if (modal) modal.classList.add('hidden');
}

// ==========================================
// 3. FINANCEIRO & PIX DA FAMÍLIA (PAIS)
// ==========================================
async function loadStudentInvoices() {
  const currentCard = document.getElementById('parent-finance-current-card');
  const currentAmount = document.getElementById('parent-current-amount');
  const currentDue = document.getElementById('parent-current-due');
  const currentTitle = document.getElementById('parent-current-title');
  const currentDesc = document.getElementById('parent-current-desc');
  const currentBadge = document.getElementById('parent-current-status-badge');
  const btnPix = document.getElementById('btn-parent-open-pix');
  const tbody = document.getElementById('parent-invoices-tbody');

  try {
    const res = await fetch(`${API_BASE}/api/student/invoices`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Falha ao carregar financeiro');
    const invoices = await res.json();
    state.parentInvoices = invoices;

    // Localiza a primeira fatura em aberto
    const pendingInv = invoices.find(i => i.status === 'pendente' || i.current_status === 'atrasado');

    if (pendingInv && currentCard) {
      currentCard.classList.remove('hidden');
      if (currentAmount) currentAmount.textContent = parseFloat(pendingInv.amount).toFixed(2).replace('.', ',');
      if (currentDue) currentDue.textContent = `Vencimento: ${pendingInv.formatted_due_date || formatDateBR(pendingInv.due_date)}`;
      if (currentTitle) currentTitle.textContent = pendingInv.title || 'Mensalidade Escolar';
      if (currentDesc) currentDesc.textContent = pendingInv.notes || 'Cobrança referente às aulas ministradas no ciclo da Escola Entrelinhas.';
      if (currentBadge) {
        const isLate = pendingInv.current_status === 'atrasado';
        currentBadge.className = `finance-badge ${isLate ? 'overdue' : 'pending'}`;
        currentBadge.textContent = isLate ? '🔴 Em Atraso' : '🟡 Pendente';
      }
      if (btnPix) {
        btnPix.onclick = () => openPixModal(pendingInv);
      }
    } else if (currentCard) {
      currentCard.innerHTML = `
        <div style="text-align:center; padding:24px 16px;">
          <span style="font-size:2.5rem; display:block; margin-bottom:8px;">🎉</span>
          <h3 style="color:#16a34a; font-weight:800; margin:0 0 4px 0;">Todas as mensalidades estão quitadas!</h3>
          <p class="text-sm text-muted" style="margin:0;">Obrigado por manter os pagamentos em dia com a Entrelinhas.</p>
        </div>
      `;
    }

    if (tbody) {
      if (invoices.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Nenhum histórico financeiro encontrado.</td></tr>';
        return;
      }

      tbody.innerHTML = invoices.map(inv => {
        const isPaid = inv.status === 'pago';
        const isLate = inv.current_status === 'atrasado';
        const statusBadge = isPaid
          ? '<span class="status-badge active">✅ Paga</span>'
          : isLate
            ? '<span class="status-badge inactive">🔴 Em Atraso</span>'
            : '<span class="status-badge warning" style="background:#fef3c7; color:#b45309;">🟡 Pendente</span>';

        return `
          <tr>
            <td>
              <strong>${inv.title}</strong>
              <small class="text-muted" style="display:block;">${inv.invoice_number || 'FAT-' + inv.id}</small>
            </td>
            <td>${inv.formatted_due_date || formatDateBR(inv.due_date)}</td>
            <td><strong>R$ ${parseFloat(inv.amount).toFixed(2).replace('.', ',')}</strong></td>
            <td>${statusBadge}</td>
            <td>
              ${!isPaid ? `
                <button type="button" class="btn-sm-action" onclick='openPixModal(${JSON.stringify(inv)})' style="background:var(--brand-orange); color:#fff; border:none; padding:5px 12px; border-radius:6px; font-weight:700; cursor:pointer;">
                  ⚡ Pagar Pix
                </button>
              ` : `
                <button type="button" class="btn-sm-action" onclick="printInvoiceReceipt(${inv.id})" style="background:#f1f5f9; color:#334155; border:1px solid #cbd5e1; padding:5px 10px; border-radius:6px; font-weight:700; cursor:pointer;">
                  📄 Recibo
                </button>
              `}
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Erro ao carregar dados financeiros.</td></tr>';
  }
}

function openPixModal(invoice) {
  const modal = document.getElementById('modal-pix-payment');
  const titleEl = document.getElementById('pix-modal-title');
  const amountEl = document.getElementById('pix-modal-amount');
  const dueEl = document.getElementById('pix-modal-due');
  const numEl = document.getElementById('pix-modal-invoice-num');
  const copyInput = document.getElementById('pix-copy-paste-input');
  const qrBox = document.getElementById('pix-qr-code-box');

  const pixCode = invoice.pix_copia_cola || '00020126580014br.gov.bcb.pix0136comercial@entrelinhas.online5204000053039865802BR5925ESCOLA ENTRELINHAS LTDA6008CAMBORIU62070503***6304';

  if (titleEl) titleEl.textContent = invoice.title || 'Pagamento de Mensalidade';
  if (amountEl) amountEl.textContent = `R$ ${parseFloat(invoice.amount).toFixed(2).replace('.', ',')}`;
  if (dueEl) dueEl.textContent = `Vencimento: ${invoice.formatted_due_date || formatDateBR(invoice.due_date)}`;
  if (numEl) numEl.textContent = invoice.invoice_number || `FAT-${invoice.id}`;
  if (copyInput) copyInput.value = pixCode;

  if (qrBox) {
    qrBox.innerHTML = '';
    if (window.QRCode && QRCode.toString) {
      QRCode.toString(pixCode, { type: 'svg', margin: 1, width: 220 }, (err, svg) => {
        if (!err && svg) {
          qrBox.innerHTML = svg;
        } else {
          renderFallbackQRCode(qrBox, pixCode);
        }
      });
    } else {
      renderFallbackQRCode(qrBox, pixCode);
    }
  }

  if (modal) modal.classList.remove('hidden');
}

function closePixModal() {
  const modal = document.getElementById('modal-pix-payment');
  if (modal) modal.classList.add('hidden');
}

function renderFallbackQRCode(container, text) {
  container.innerHTML = `
    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; width:200px; height:200px; background:#fff; border:2px solid #0e2970; border-radius:8px; padding:12px; text-align:center;">
      <span style="font-size:2.5rem; margin-bottom:4px;">⚡</span>
      <strong style="color:#0e2970; font-size:0.85rem;">PIX ENTRELINHAS</strong>
      <span style="font-size:0.75rem; color:#64748b; margin-top:4px;">Copie o código abaixo para pagar no app do seu banco.</span>
    </div>
  `;
}

function printInvoiceReceipt(invoiceId) {
  let inv = (state.parentInvoices || []).find(i => String(i.id) === String(invoiceId));
  if (!inv && state.adminInvoices) {
    inv = state.adminInvoices.find(i => String(i.id) === String(invoiceId));
  }
  if (!inv) return;

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Recibo de Pagamento - Escola Entrelinhas</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; color: #1e293b; }
        .receipt-card { max-width: 600px; margin: 0 auto; border: 2px solid #0e2970; border-radius: 12px; padding: 32px; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #f1f5f9; padding-bottom: 16px; margin-bottom: 24px; }
        .logo { font-size: 24px; font-weight: 800; color: #0e2970; }
        .receipt-num { font-size: 14px; color: #64748b; }
        .title { font-size: 18px; font-weight: 800; color: #f28b18; text-transform: uppercase; margin-bottom: 16px; text-align: center; }
        .row { display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 15px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px; }
        .row strong { color: #0f172a; }
        .amount-box { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 16px; text-align: center; margin: 24px 0; }
        .amount-val { font-size: 28px; font-weight: 900; color: #15803d; }
        .footer { margin-top: 32px; font-size: 12px; text-align: center; color: #94a3b8; }
      </style>
    </head>
    <body>
      <div class="receipt-card">
        <div class="header">
          <div class="logo">ESCOLA ENTRELINHAS</div>
          <div class="receipt-num">Recibo Nº ${inv.invoice_number || 'FAT-' + inv.id}</div>
        </div>
        <div class="title">Comprovante de Quitação Escolar</div>
        <div class="row">
          <span>Aluno(a):</span>
          <strong>${inv.student_name || 'Aluno Entrelinhas'}</strong>
        </div>
        <div class="row">
          <span>Descrição:</span>
          <strong>${inv.title}</strong>
        </div>
        <div class="row">
          <span>Forma de Pagamento:</span>
          <strong>${(inv.payment_method || 'Pix').toUpperCase()}</strong>
        </div>
        <div class="row">
          <span>Data de Pagamento:</span>
          <strong>${inv.formatted_paid_date || getSaoPauloDateAndTimeString().dateBr}</strong>
        </div>

        <div class="amount-box">
          <div style="font-size:13px; color:#166534; font-weight:700;">VALOR PAGO</div>
          <div class="amount-val">R$ ${parseFloat(inv.amount).toFixed(2).replace('.', ',')}</div>
        </div>

        <p style="font-size:13px; line-height:1.5; color:#475569; text-align:center;">
          Declaramos para os devidos fins que a fatura discriminada acima foi integralmente quitada, dando plena quitação das obrigações do período.
        </p>

        <div class="footer">
          Escola Entrelinhas Ltda • CNPJ / Comercial: comercial@entrelinhas.online<br>
          Emitido em ${getSaoPauloDateAndTimeString().formatted}
        </div>
      </div>
      <script>
        window.onload = function() { window.print(); }
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

// ==========================================
// 4. PAINEL FINANCEIRO (ADMIN)
// ==========================================
async function loadAdminFinancialDashboard() {
  try {
    const resKpi = await fetch(`${API_BASE}/api/financial/dashboard`, { headers: getAuthHeaders() });
    if (resKpi.ok) {
      const kpiData = await resKpi.json();
      // A API devolve os totais dentro de "summary"
      const sum = kpiData.summary || {};
      const kpis = {
        month_received: sum.month_received,
        paid_invoices_count: sum.paid_count,
        to_receive: sum.to_receive,
        pending_invoices_count: sum.pending_count,
        overdue: sum.overdue_amount,
        overdue_invoices_count: sum.overdue_count,
        delinquency_rate: sum.inadimplencia_rate,
        month_expected: sum.month_expected
      };
      
      const elRec = document.getElementById('admin-fin-month-received');
      const elRecCount = document.getElementById('admin-fin-paid-count');
      const elToRec = document.getElementById('admin-fin-to-receive');
      const elToRecCount = document.getElementById('admin-fin-pending-count');
      const elOverdue = document.getElementById('admin-fin-overdue');
      const elOverdueCount = document.getElementById('admin-fin-overdue-count');
      const elInad = document.getElementById('admin-fin-inadimplencia');
      const elExp = document.getElementById('admin-fin-month-expected');

      if (elRec) elRec.textContent = `R$ ${parseFloat(kpis.month_received || 0).toFixed(2).replace('.', ',')}`;
      if (elRecCount) elRecCount.textContent = `${kpis.paid_invoices_count || 0} faturas quitadas`;
      if (elToRec) elToRec.textContent = `R$ ${parseFloat(kpis.to_receive || 0).toFixed(2).replace('.', ',')}`;
      if (elToRecCount) elToRecCount.textContent = `${kpis.pending_invoices_count || 0} faturas pendentes`;
      if (elOverdue) elOverdue.textContent = `R$ ${parseFloat(kpis.overdue || 0).toFixed(2).replace('.', ',')}`;
      if (elOverdueCount) elOverdueCount.textContent = `${kpis.overdue_invoices_count || 0} em cobrança`;
      if (elInad) elInad.textContent = `${kpis.delinquency_rate || 0}%`;
      if (elExp) elExp.textContent = `Previsto: R$ ${parseFloat(kpis.month_expected || 0).toFixed(2).replace('.', ',')}`;
    }

    const resInvoices = await fetch(`${API_BASE}/api/financial/invoices`, { headers: getAuthHeaders() });
    if (resInvoices.ok) {
      const data = await resInvoices.json();
      state.adminInvoices = data;
      filterAdminInvoices();
    }
  } catch (err) {
    console.warn('Erro ao carregar financeiro admin:', err);
  }
}

function filterAdminInvoices(statusFilter = null) {
  if (statusFilter !== null) {
    state.adminInvoiceStatusFilter = statusFilter;
  }
  const status = state.adminInvoiceStatusFilter || '';
  const search = (document.getElementById('admin-finance-search')?.value || '').toLowerCase();
  const tbody = document.getElementById('admin-invoices-tbody');
  if (!tbody || !state.adminInvoices) return;

  const filtered = state.adminInvoices.filter(inv => {
    const matchStatus = !status || inv.status === status || (status === 'atrasado' && inv.current_status === 'atrasado');
    const matchSearch = !search || 
      (inv.student_name && inv.student_name.toLowerCase().includes(search)) ||
      (inv.title && inv.title.toLowerCase().includes(search)) ||
      (inv.invoice_number && inv.invoice_number.toLowerCase().includes(search));
    return matchStatus && matchSearch;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">Nenhuma fatura encontrada com os filtros selecionados.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(inv => {
    const isPaid = inv.status === 'pago';
    const isLate = inv.current_status === 'atrasado';
    const isCancelled = inv.status === 'cancelado';
    const statusBadge = isCancelled
      ? '<span class="status-badge" style="background:#f1f5f9; color:#64748b;">⚪ Cancelada</span>'
      : isPaid
      ? '<span class="status-badge active">✅ Paga</span>'
      : isLate
        ? '<span class="status-badge inactive">🔴 Em Atraso</span>'
        : '<span class="status-badge warning" style="background:#fef3c7; color:#b45309;">🟡 Pendente</span>';

    return `
      <tr>
        <td>
          <strong>${inv.title}</strong>
          <small class="text-muted" style="display:block;">${inv.invoice_number || 'FAT-' + inv.id}</small>
        </td>
        <td>
          <strong>${inv.student_name || 'Aluno'}</strong>
          <small class="text-muted" style="display:block;">${inv.parent_name ? 'Resp: ' + inv.parent_name : ''}</small>
        </td>
        <td>${inv.formatted_due_date || formatDateBR(inv.due_date)}</td>
        <td><strong>R$ ${parseFloat(inv.net_amount ?? inv.amount).toFixed(2).replace('.', ',')}</strong></td>
        <td>${statusBadge}</td>
        <td>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            ${isCancelled ? '' : !isPaid ? `
              <button type="button" class="btn-sm-action" onclick="markInvoiceAsPaid(${inv.id})" style="background:#22c55e; color:#fff; border:none; padding:4px 8px; border-radius:6px; font-weight:700; font-size:0.8rem; cursor:pointer;" title="Confirmar recebimento">
                ✓ Baixar
              </button>
              <button type="button" class="btn-sm-action" onclick='openPixModal(${JSON.stringify(inv)})' style="background:#0e2970; color:#fff; border:none; padding:4px 8px; border-radius:6px; font-weight:700; font-size:0.8rem; cursor:pointer;" title="Visualizar QR Code Pix">
                ⚡ Pix
              </button>
            ` : `
              <button type="button" class="btn-sm-action" onclick="printInvoiceReceipt(${inv.id})" style="background:#f1f5f9; color:#334155; border:1px solid #cbd5e1; padding:4px 8px; border-radius:6px; font-weight:700; font-size:0.8rem; cursor:pointer;">
                📄 Recibo
              </button>
            `}
            ${inv.status === 'pendente' ? `
            <button type="button" class="btn-sm-action" onclick="cancelInvoice(${inv.id})" style="background:#fee2e2; color:#dc2626; border:none; padding:4px 8px; border-radius:6px; font-weight:700; font-size:0.8rem; cursor:pointer;" title="Cancelar fatura">
              ✕
            </button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function markInvoiceAsPaid(invoiceId) {
  showAppConfirm('Deseja dar baixa manual nesta fatura confirmando o recebimento?', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/financial/invoices/${invoiceId}/pay`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ payment_method: 'pix' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao liquidar fatura');
      showToast('Fatura liquidada com sucesso! Recibo gerado.');
      loadAdminFinancialDashboard();
    } catch (err) {
      showAppAlert(err.message, 'Liquidação');
    }
  }, 'Confirmar Recebimento');
}

async function cancelInvoice(invoiceId) {
  showAppConfirm('Tem certeza de que deseja cancelar esta fatura?', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/financial/invoices/${invoiceId}/cancel`, {
        method: 'PATCH',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao cancelar');
      showToast('Fatura cancelada.');
      loadAdminFinancialDashboard();
    } catch (err) {
      showAppAlert(err.message, 'Cancelar Fatura');
    }
  }, 'Cancelar Fatura', true);
}

function openNewInvoiceModal() {
  const modal = document.getElementById('modal-new-invoice');
  const studentSelect = document.getElementById('inv-student-id');
  if (studentSelect) {
    studentSelect.innerHTML = '<option value="">Carregando alunos...</option>';
    // Lista completa (sem os filtros da tela de alunos) e só alunos ativos
    apiJson('/api/students').then(list => {
      studentSelect.innerHTML = '<option value="">Selecione o(a) aluno(a)...</option>' +
        list.filter(s => s.status === 'ativo')
          .map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.objective_grade || 'Aluno')})</option>`).join('');
    }).catch(err => showAppAlert(err.message, 'Gerar Fatura'));
  }
  loadInvoicePlans();
  const dueDateInput = document.getElementById('inv-due-date');
  if (dueDateInput) {
    const d = new Date();
    d.setDate(d.getDate() + 10);
    dueDateInput.value = toIsoDateOnly(d);
  }
  if (modal) modal.classList.remove('hidden');
}

function closeNewInvoiceModal() {
  const modal = document.getElementById('modal-new-invoice');
  if (modal) modal.classList.add('hidden');
}

// ==========================================
// 5. GESTÃO DE CURSOS & LMS (ADMIN)
// ==========================================
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function closeModalById(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('hidden');
}

async function apiJson(url, options = {}) {
  const res = await fetch(`${API_BASE}${url}`, { headers: getAuthHeaders(), ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro ao comunicar com o servidor');
  return data;
}

const MODALITY_LABELS = { hibrido: 'Híbrido', presencial: 'Presencial', online: 'Online' };

async function loadAdminCourses() {
  const grid = document.getElementById('admin-courses-grid');
  if (!grid) return;

  try {
    grid.innerHTML = '<div class="loading-state">Carregando catálogo de cursos...</div>';
    const courses = await apiJson('/api/courses?all=1');
    state.adminCourses = courses;

    if (courses.length === 0) {
      grid.innerHTML = '<div class="text-center text-muted py-4">Nenhum curso cadastrado ainda. Use "Criar Novo Curso".</div>';
      return;
    }

    grid.innerHTML = courses.map(c => `
      <div class="course-manage-card" style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:18px; margin-bottom:14px;${c.status !== 'ativo' ? ' opacity:0.7;' : ''}">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; gap:10px;">
          <div>
            <span class="course-badge" style="font-size:0.75rem;">${escapeHtml((c.category || 'geral').toUpperCase())}</span>
            <h3 style="margin:4px 0 2px 0; font-size:1.1rem; color:var(--text-main); font-weight:800;">${escapeHtml(c.icon || '📚')} ${escapeHtml(c.title)}</h3>
            <p style="margin:0; font-size:0.85rem; color:#64748b;">${escapeHtml(c.headline || c.description || '')}</p>
          </div>
          <div style="text-align:right; flex-shrink:0;">
            <strong style="color:var(--brand-blue); font-size:1.1rem;">R$ ${parseFloat(c.price || 0).toFixed(2).replace('.', ',')}</strong>
            <small class="text-muted" style="display:block;">${c.status === 'ativo' ? '🟢 Ativo no site' : '⚪ Inativo'}</small>
          </div>
        </div>

        <div style="display:flex; flex-wrap:wrap; gap:12px; font-size:0.8rem; color:#475569; padding:8px 0; border-top:1px solid #f1f5f9; border-bottom:1px solid #f1f5f9; margin-bottom:12px;">
          <span>🧩 <strong>${parseInt(c.total_modules) || 0}</strong> módulo(s)</span>
          <span>📚 <strong>${parseInt(c.total_lessons) || 0}</strong> aula(s)</span>
          <span>⏱️ <strong>${parseInt(c.workload_hours) || 0}h</strong> carga horária</span>
          <span>🏫 ${escapeHtml(MODALITY_LABELS[c.modality] || c.modality || '—')}</span>
          ${c.subject_name ? `<span>🏷️ ${escapeHtml(c.subject_name)}</span>` : ''}
        </div>

        <div style="display:flex; justify-content:flex-end; gap:8px; flex-wrap:wrap;">
          <button type="button" class="btn-card-action secondary" style="flex:0 0 auto;" onclick="openCourseContentModal(${c.id})">📚 Módulos & Aulas</button>
          <button type="button" class="btn-card-action primary" style="flex:0 0 auto;" onclick="openCourseModal(${c.id})">✏️ Editar</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<div class="text-danger py-2">Erro ao carregar cursos: ${escapeHtml(err.message)}</div>`;
  }
}

async function openCourseModal(courseId = null) {
  const course = courseId ? (state.adminCourses || []).find(c => c.id === courseId) : null;
  const subjectSelect = document.getElementById('course-subject');
  const subjects = state.subjects && state.subjects.length ? state.subjects : await apiJson('/api/subjects').catch(() => []);
  subjectSelect.innerHTML = '<option value="">Nenhuma</option>' +
    subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  document.getElementById('modal-course-title').textContent = course ? '✏️ Editar Curso' : '➕ Novo Curso';
  document.getElementById('course-edit-id').value = course ? course.id : '';
  document.getElementById('course-title').value = course ? course.title : '';
  document.getElementById('course-headline').value = course ? (course.headline || '') : '';
  document.getElementById('course-description').value = course ? (course.description || '') : '';
  subjectSelect.value = course && course.subject_id ? course.subject_id : '';
  document.getElementById('course-modality').value = course ? (course.modality || 'hibrido') : 'hibrido';
  document.getElementById('course-price').value = course ? parseFloat(course.price || 0).toFixed(2) : '350.00';
  document.getElementById('course-workload').value = course ? (course.workload_hours || 40) : 40;
  const categorySelect = document.getElementById('course-category');
  if (course && course.category && !Array.from(categorySelect.options).some(o => o.value === course.category)) {
    categorySelect.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(course.category)}">${escapeHtml(course.category)}</option>`);
  }
  categorySelect.value = course ? (course.category || 'reforco') : 'reforco';
  document.getElementById('course-status').value = course ? (course.status || 'ativo') : 'ativo';
  document.getElementById('modal-course-admin').classList.remove('hidden');
}

async function handleCourseSubmit(e) {
  e.preventDefault();
  const editId = document.getElementById('course-edit-id').value;
  const payload = {
    title: document.getElementById('course-title').value.trim(),
    headline: document.getElementById('course-headline').value.trim(),
    description: document.getElementById('course-description').value.trim(),
    subject_id: document.getElementById('course-subject').value ? parseInt(document.getElementById('course-subject').value) : null,
    modality: document.getElementById('course-modality').value,
    price: document.getElementById('course-price').value,
    workload_hours: document.getElementById('course-workload').value,
    category: document.getElementById('course-category').value,
    status: document.getElementById('course-status').value
  };
  try {
    await apiJson(editId ? `/api/courses/${editId}` : '/api/courses', {
      method: editId ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    showToast(editId ? 'Curso atualizado!' : 'Curso criado!');
    closeModalById('modal-course-admin');
    loadAdminCourses();
  } catch (err) {
    showAppAlert(err.message, 'Salvar Curso');
  }
}

async function openCourseContentModal(courseId) {
  document.getElementById('course-content-id').value = courseId;
  document.getElementById('modal-course-content').classList.remove('hidden');
  await renderCourseContent(courseId);
}

async function renderCourseContent(courseId) {
  const container = document.getElementById('course-content-modules');
  const moduleSelect = document.getElementById('lesson-module');
  container.innerHTML = '<div class="loading-state">Carregando conteúdo...</div>';
  try {
    const course = await apiJson(`/api/courses/${courseId}`);
    document.getElementById('course-content-title').textContent = course.title;
    const modules = course.modules || [];
    moduleSelect.innerHTML = modules.length
      ? modules.map(m => `<option value="${m.id}">${escapeHtml(m.title)}</option>`).join('')
      : '<option value="">Crie um módulo primeiro</option>';

    if (modules.length === 0) {
      container.innerHTML = '<p class="text-muted">Este curso ainda não tem módulos.</p>';
      return;
    }
    container.innerHTML = modules.map((m, idx) => `
      <div class="course-module-block">
        <div class="course-module-header">
          <strong>${idx + 1}. ${escapeHtml(m.title)}</strong>
          <button type="button" class="btn-card-action secondary" style="flex:0 0 auto;" onclick="deleteCourseModule(${m.id})">🗑️ Excluir módulo</button>
        </div>
        ${(m.lessons || []).length === 0 ? '<p class="text-xs text-muted" style="margin:6px 0 0;">Nenhuma aula neste módulo.</p>' : ''}
        ${(m.lessons || []).map(l => `
          <div class="course-lesson-row">
            <span>▶️ ${escapeHtml(l.title)} <small class="text-muted">· ${parseInt(l.duration_minutes) || 0} min${l.video_url ? ' · gravação' : ''}${l.live_meeting_url ? ' · ao vivo' : ''}</small></span>
            <button type="button" class="btn-card-action secondary" style="flex:0 0 auto;" onclick="deleteCourseLesson(${l.id})" aria-label="Excluir aula">🗑️</button>
          </div>
        `).join('')}
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div class="text-danger">${escapeHtml(err.message)}</div>`;
  }
}

async function handleAddModule(e) {
  e.preventDefault();
  const courseId = document.getElementById('course-content-id').value;
  const titleInput = document.getElementById('module-title');
  try {
    await apiJson(`/api/courses/${courseId}/modules`, { method: 'POST', body: JSON.stringify({ title: titleInput.value.trim() }) });
    titleInput.value = '';
    showToast('Módulo adicionado!');
    await renderCourseContent(courseId);
    loadAdminCourses();
  } catch (err) {
    showAppAlert(err.message, 'Novo Módulo');
  }
}

async function handleAddLesson(e) {
  e.preventDefault();
  const courseId = document.getElementById('course-content-id').value;
  const moduleId = document.getElementById('lesson-module').value;
  if (!moduleId) {
    showAppAlert('Crie um módulo antes de adicionar aulas.', 'Nova Aula');
    return;
  }
  const payload = {
    title: document.getElementById('lesson-title').value.trim(),
    video_url: document.getElementById('lesson-video').value.trim() || null,
    live_meeting_url: document.getElementById('lesson-live').value.trim() || null,
    duration_minutes: document.getElementById('lesson-duration').value
  };
  try {
    await apiJson(`/api/modules/${moduleId}/lessons`, { method: 'POST', body: JSON.stringify(payload) });
    ['lesson-title', 'lesson-video', 'lesson-live'].forEach(id => { document.getElementById(id).value = ''; });
    showToast('Aula adicionada!');
    await renderCourseContent(courseId);
    loadAdminCourses();
  } catch (err) {
    showAppAlert(err.message, 'Nova Aula');
  }
}

function deleteCourseModule(moduleId) {
  showAppConfirm('Excluir este módulo e todas as aulas dele? O progresso dos alunos nessas aulas também será apagado.', async () => {
    try {
      await apiJson(`/api/modules/${moduleId}`, { method: 'DELETE' });
      showToast('Módulo excluído.');
      await renderCourseContent(document.getElementById('course-content-id').value);
      loadAdminCourses();
    } catch (err) {
      showAppAlert(err.message, 'Excluir Módulo');
    }
  }, 'Excluir Módulo', true);
}

function deleteCourseLesson(lessonId) {
  showAppConfirm('Excluir esta aula? O progresso dos alunos nela também será apagado.', async () => {
    try {
      await apiJson(`/api/lessons/${lessonId}`, { method: 'DELETE' });
      showToast('Aula excluída.');
      await renderCourseContent(document.getElementById('course-content-id').value);
      loadAdminCourses();
    } catch (err) {
      showAppAlert(err.message, 'Excluir Aula');
    }
  }, 'Excluir Aula', true);
}

// ==========================================
// 5.1 TAREFAS & REDAÇÕES (ADMIN E PROFESSOR)
// ==========================================
const ASSIGNMENT_STATUS = {
  pendente: { label: '⚠️ Pendente de envio', bg: '#fee2e2', color: '#dc2626' },
  enviado: { label: '⏳ Aguardando correção', bg: '#fef3c7', color: '#d97706' },
  corrigido: { label: '✅ Corrigida', bg: '#dcfce7', color: '#16a34a' }
};

async function loadAssignmentsView() {
  const list = document.getElementById('assignments-list');
  if (!list) return;
  list.innerHTML = '<div class="loading-state">Carregando atividades...</div>';
  try {
    state.assignments = await apiJson('/api/assignments');
    renderAssignmentsList();
  } catch (err) {
    list.innerHTML = `<div class="text-danger py-2">${escapeHtml(err.message)}</div>`;
  }
}

function renderAssignmentsList() {
  const list = document.getElementById('assignments-list');
  const filter = state.assignmentsFilter || '';
  const items = (state.assignments || []).filter(a => !filter || a.status === filter);
  if (items.length === 0) {
    list.innerHTML = '<div class="text-center text-muted py-4">Nenhuma atividade neste filtro.</div>';
    return;
  }
  list.innerHTML = items.map(a => {
    const st = ASSIGNMENT_STATUS[a.status] || { label: a.status, bg: '#f1f5f9', color: '#475569' };
    const canGrade = a.status === 'enviado' || a.status === 'corrigido';
    return `
      <div class="assignment-card" style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:6px;">
          <div>
            <span style="font-size:0.75rem; color:#64748b; font-weight:700; text-transform:uppercase;">${escapeHtml(a.student_name)}${a.course_title ? ' · ' + escapeHtml(a.course_title) : ''}</span>
            <h4 style="margin:2px 0 4px 0; color:var(--text-main); font-size:1rem; font-weight:800;">${escapeHtml(a.title)}</h4>
          </div>
          <span style="background:${st.bg}; color:${st.color}; font-weight:800; padding:4px 8px; border-radius:6px; font-size:0.78rem; white-space:nowrap;">${st.label}</span>
        </div>
        ${a.instructions ? `<p style="margin:0 0 8px 0; color:#475569; font-size:0.85rem;">${escapeHtml(a.instructions)}</p>` : ''}
        ${a.status === 'corrigido' ? `<p style="margin:0 0 8px 0; font-size:0.85rem;"><strong>Nota ${Number(a.grade).toFixed(1).replace('.', ',')}</strong> — ${escapeHtml(a.teacher_feedback || '')}</p>` : ''}
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; padding-top:8px; border-top:1px solid #f1f5f9;">
          <span class="text-xs text-muted">
            ${a.formatted_due_date ? 'Entrega até ' + a.formatted_due_date : 'Sem prazo'}
            ${a.formatted_submitted_at ? ' · enviado em ' + a.formatted_submitted_at : ''}
            ${a.teacher_name ? ' · Prof. ' + escapeHtml(a.teacher_name) : ''}
          </span>
          ${canGrade ? `<button type="button" class="btn-card-action primary" style="flex:0 0 auto;" onclick="openGradeAssignmentModal(${a.id})">${a.status === 'corrigido' ? '✏️ Revisar correção' : '✓ Corrigir'}</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function openNewAssignmentModal() {
  const studentSelect = document.getElementById('assign-student');
  const courseSelect = document.getElementById('assign-course');
  studentSelect.innerHTML = '<option value="">Carregando alunos...</option>';
  document.getElementById('modal-new-assignment').classList.remove('hidden');
  try {
    const [students, courses] = await Promise.all([apiJson('/api/students'), apiJson('/api/courses')]);
    const active = students.filter(s => s.status === 'ativo');
    studentSelect.innerHTML = '<option value="">Selecione o(a) aluno(a)...</option>' +
      active.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    courseSelect.innerHTML = '<option value="">Nenhum</option>' +
      courses.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join('');
    const due = new Date();
    due.setDate(due.getDate() + 7);
    document.getElementById('assign-due').value = toIsoDateOnly(due);
    document.getElementById('assign-due').min = toIsoDateOnly(new Date());
  } catch (err) {
    showAppAlert(err.message, 'Nova Tarefa');
  }
}

async function handleNewAssignmentSubmit(e) {
  e.preventDefault();
  const payload = {
    student_id: parseInt(document.getElementById('assign-student').value),
    title: document.getElementById('assign-title').value.trim(),
    instructions: document.getElementById('assign-instructions').value.trim() || null,
    due_date: document.getElementById('assign-due').value || null,
    course_id: document.getElementById('assign-course').value ? parseInt(document.getElementById('assign-course').value) : null
  };
  try {
    await apiJson('/api/assignments', { method: 'POST', body: JSON.stringify(payload) });
    showToast('Tarefa enviada para o aluno!');
    closeModalById('modal-new-assignment');
    document.getElementById('form-new-assignment').reset();
    loadAssignmentsView();
  } catch (err) {
    showAppAlert(err.message, 'Nova Tarefa');
  }
}

// ==========================================
// 5.2 PLANOS FINANCEIROS NO MODAL DE FATURA
// ==========================================
async function loadInvoicePlans() {
  const planSelect = document.getElementById('inv-plan');
  if (!planSelect) return;
  try {
    state.financialPlans = await apiJson('/api/financial/plans');
    planSelect.innerHTML = '<option value="">Cobrança avulsa</option>' +
      state.financialPlans.map(p => `<option value="${p.id}">${escapeHtml(p.name)} — R$ ${parseFloat(p.amount).toFixed(2).replace('.', ',')}</option>`).join('');
  } catch (err) {
    planSelect.innerHTML = '<option value="">Cobrança avulsa</option>';
  }
}

function applyInvoicePlan() {
  const planId = document.getElementById('inv-plan').value;
  const plan = (state.financialPlans || []).find(p => String(p.id) === String(planId));
  if (!plan) return;
  const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' }).format(new Date());
  document.getElementById('inv-title').value = `Mensalidade ${monthName} — ${plan.name}`;
  document.getElementById('inv-amount').value = parseFloat(plan.amount).toFixed(2);
  if (plan.due_day) {
    const now = new Date();
    let due = new Date(now.getFullYear(), now.getMonth(), plan.due_day);
    if (due < now) due = new Date(now.getFullYear(), now.getMonth() + 1, plan.due_day);
    document.getElementById('inv-due-date').value = toIsoDateOnly(due);
  }
}

function setupPortalManagementUI() {
  const btnAddCourse = document.getElementById('btn-admin-add-course');
  if (btnAddCourse) btnAddCourse.addEventListener('click', () => openCourseModal(null));
  const formCourse = document.getElementById('form-course-admin');
  if (formCourse) formCourse.addEventListener('submit', handleCourseSubmit);
  const formModule = document.getElementById('form-add-module');
  if (formModule) formModule.addEventListener('submit', handleAddModule);
  const formLesson = document.getElementById('form-add-lesson');
  if (formLesson) formLesson.addEventListener('submit', handleAddLesson);

  const btnNewAssign = document.getElementById('btn-new-assignment');
  if (btnNewAssign) btnNewAssign.addEventListener('click', openNewAssignmentModal);
  const formNewAssign = document.getElementById('form-new-assignment');
  if (formNewAssign) formNewAssign.addEventListener('submit', handleNewAssignmentSubmit);
  document.querySelectorAll('#assignments-status-filters .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#assignments-status-filters .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.assignmentsFilter = pill.getAttribute('data-status');
      renderAssignmentsList();
    });
  });

  const planSelect = document.getElementById('inv-plan');
  if (planSelect) planSelect.addEventListener('change', applyInvoicePlan);
}

// ==========================================
// 6. GESTÃO DE LEADS & PRÉ-MATRÍCULAS (ADMIN - KANBAN)
// ==========================================
const LEAD_COLUMNS = [
  { id: 'novo', title: 'Novo Contato', icon: '🟡', desc: 'Chegou pelo site ou cadastro' },
  { id: 'contatado', title: 'Em Atendimento', icon: '💬', desc: 'Primeiro contato realizado' },
  { id: 'agendado', title: 'Aula Experimental', icon: '📅', desc: 'Visita ou aula agendada' },
  { id: 'matriculado', title: 'Matriculado', icon: '🎉', desc: 'Matrícula confirmada' },
  { id: 'arquivado', title: 'Arquivado', icon: '⚪', desc: 'Desistiu ou sem interesse' }
];

const LEAD_SOURCE_INFO = {
  site: { label: 'Site', icon: '🌐' },
  whatsapp: { label: 'WhatsApp', icon: '💬' },
  instagram: { label: 'Instagram', icon: '📸' },
  facebook: { label: 'Facebook', icon: '👍' },
  indicacao: { label: 'Indicação', icon: '🤝' },
  telefone: { label: 'Telefone', icon: '📞' },
  presencial: { label: 'Presencial', icon: '🏫' },
  outro: { label: 'Outro', icon: '📌' }
};

let leadSearchQuery = '';
let leadSourceFilter = '';

async function loadAdminLeads() {
  const kanban = document.getElementById('leads-kanban');
  if (!kanban) return;

  try {
    kanban.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:30px;" class="text-muted">Carregando funil de interessados...</div>';
    const tbody = document.getElementById('admin-leads-table-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">Carregando contatos...</td></tr>';

    const res = await fetch(`${API_BASE}/api/leads`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error('Falha ao carregar leads');
    state.adminLeads = await res.json();
    renderLeadsKanban();
    renderLeadsTable();
  } catch (err) {
    kanban.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:30px; color:var(--danger);">${escapeHtmlDoc(err.message)}</div>`;
  }
}

function getFilteredLeads() {
  const leads = state.adminLeads || [];
  const search = (leadSearchQuery || '').toLowerCase().trim();
  const source = leadSourceFilter || '';

  return leads.filter(l => {
    if (source && (l.source || 'site') !== source) return false;
    if (search) {
      const matchName = (l.name || '').toLowerCase().includes(search);
      const matchPhone = (l.phone || '').toLowerCase().includes(search);
      const matchEmail = (l.email || '').toLowerCase().includes(search);
      const matchCourse = (l.course_interest || '').toLowerCase().includes(search);
      const matchGrade = (l.student_grade || '').toLowerCase().includes(search);
      const matchMsg = (l.message || '').toLowerCase().includes(search);
      const matchNotes = (l.notes || '').toLowerCase().includes(search);
      if (!matchName && !matchPhone && !matchEmail && !matchCourse && !matchGrade && !matchMsg && !matchNotes) return false;
    }
    return true;
  });
}

function renderLeadsKanban() {
  const kanban = document.getElementById('leads-kanban');
  if (!kanban) return;

  const filtered = getFilteredLeads();
  // No Kanban entram apenas os leads marcados com in_kanban === true
  const kanbanLeads = filtered.filter(l => Boolean(l.in_kanban));

  const columnsHtml = LEAD_COLUMNS.map((col, colIdx) => {
    const colLeads = kanbanLeads.filter(l => (l.status || 'novo') === col.id);
    const prevCol = colIdx > 0 ? LEAD_COLUMNS[colIdx - 1] : null;
    const nextCol = colIdx < LEAD_COLUMNS.length - 1 ? LEAD_COLUMNS[colIdx + 1] : null;

    const cardsHtml = colLeads.map(l => {
      const srcInfo = LEAD_SOURCE_INFO[l.source] || LEAD_SOURCE_INFO['site'];
      const cleanPhone = (l.phone || '').replace(/\D/g, '');
      const waLink = cleanPhone
        ? `https://wa.me/55${cleanPhone}?text=${encodeURIComponent(`Olá ${l.name}, tudo bem? Aqui é da Escola Entrelinhas sobre seu interesse em ${l.course_interest || 'nossos cursos'}!`)}`
        : null;

      const dateStr = l.created_at ? new Date(l.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';

      return `
        <div class="lead-card" draggable="true" data-id="${l.id}">
          <div class="lead-card-header">
            <span class="lead-source-tag">${srcInfo.icon} ${srcInfo.label}</span>
            <div style="display:flex; align-items:center; gap:6px;">
              ${dateStr ? `<span class="lead-date-tag">${dateStr}</span>` : ''}
              <button type="button" class="btn-lead-unkanban" data-id="${l.id}" title="Tirar do Kanban e manter na lista geral">✕</button>
            </div>
          </div>
          <div class="lead-card-title" title="Clique para editar">${escapeHtmlDoc(l.name)}</div>
          ${l.course_interest ? `<div class="lead-card-course">📚 <strong>${escapeHtmlDoc(l.course_interest)}</strong>${l.student_grade ? ' • ' + escapeHtmlDoc(l.student_grade) : ''}</div>` : ''}
          ${l.message ? `<div class="lead-card-msg" title="${escapeHtmlDoc(l.message)}">💬 ${escapeHtmlDoc(l.message)}</div>` : ''}
          ${l.notes ? `<div class="lead-card-notes" title="${escapeHtmlDoc(l.notes)}">📌 ${escapeHtmlDoc(l.notes)}</div>` : ''}
          
          <div class="lead-card-contacts">
            ${waLink ? `
              <a href="${waLink}" target="_blank" rel="noopener" class="lead-wa-btn" title="Abrir conversa no WhatsApp">
                📱 <span>${escapeHtmlDoc(l.phone)}</span>
              </a>
            ` : `<span class="text-xs text-muted">📞 ${escapeHtmlDoc(l.phone || 'Sem telefone')}</span>`}
          </div>

          <div class="lead-card-actions">
            <div class="lead-nav-btns">
              ${prevCol ? `<button type="button" class="btn-lead-step btn-step-prev" data-id="${l.id}" data-target="${prevCol.id}" title="Mover para ${prevCol.title}">◀</button>` : '<span class="step-placeholder"></span>'}
              <button type="button" class="btn-lead-edit" data-id="${l.id}" title="Editar lead">✏️</button>
              <button type="button" class="btn-lead-del" data-id="${l.id}" title="Excluir">🗑️</button>
              ${nextCol ? `<button type="button" class="btn-lead-step btn-step-next" data-id="${l.id}" data-target="${nextCol.id}" title="Mover para ${nextCol.title}">▶</button>` : '<span class="step-placeholder"></span>'}
            </div>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="kanban-col kanban-col-${col.id}">
        <div class="kanban-col-header">
          <div class="kanban-col-title-box">
            <span class="kanban-col-icon">${col.icon}</span>
            <div>
              <span class="kanban-col-title">${col.title}</span>
              <span class="kanban-col-desc">${col.desc}</span>
            </div>
          </div>
          <span class="kanban-col-count">${colLeads.length}</span>
        </div>
        <div class="kanban-col-body" data-status="${col.id}">
          ${cardsHtml.length > 0 ? cardsHtml : '<div class="kanban-empty-drop text-muted text-xs">Nenhum lead nesta etapa</div>'}
        </div>
      </div>
    `;
  }).join('');

  kanban.innerHTML = columnsHtml;
  bindKanbanInteractions();
}

function renderLeadsTable() {
  const tbody = document.getElementById('admin-leads-table-tbody');
  if (!tbody) return;

  const allLeads = state.adminLeads || [];
  const inboxCount = allLeads.filter(l => !l.in_kanban).length;
  const inKanbanCount = allLeads.filter(l => Boolean(l.in_kanban)).length;

  const badgeInbox = document.getElementById('badge-leads-inbox-count');
  const badgeKanban = document.getElementById('badge-leads-kanban-count');
  if (badgeInbox) badgeInbox.textContent = `📥 ${inboxCount} na caixa de entrada`;
  if (badgeKanban) badgeKanban.textContent = `📌 ${inKanbanCount} no Kanban`;

  const filtered = getFilteredLeads();

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-4">Nenhum contato encontrado com os filtros atuais.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(l => {
    const srcInfo = LEAD_SOURCE_INFO[l.source] || LEAD_SOURCE_INFO['site'];
    const cleanPhone = (l.phone || '').replace(/\D/g, '');
    const waLink = cleanPhone
      ? `https://wa.me/55${cleanPhone}?text=${encodeURIComponent(`Olá ${l.name}, tudo bem? Aqui é da Escola Entrelinhas sobre seu interesse em ${l.course_interest || 'nossos cursos'}!`)}`
      : null;

    const dt = l.created_at ? new Date(l.created_at) : null;
    const dateFormatted = dt ? `${dt.toLocaleDateString('pt-BR')} <small class="text-muted">${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small>` : '-';

    const isInKanban = Boolean(l.in_kanban);

    return `
      <tr class="${!isInKanban ? 'row-inbox-lead' : ''}">
        <td style="white-space:nowrap;">${dateFormatted}</td>
        <td>
          <span class="lead-source-tag">${srcInfo.icon} ${srcInfo.label}</span>
        </td>
        <td>
          <strong>${escapeHtmlDoc(l.name)}</strong>
          ${l.email ? `<small class="text-muted" style="display:block;">${escapeHtmlDoc(l.email)}</small>` : ''}
        </td>
        <td>
          ${waLink ? `
            <a href="${waLink}" target="_blank" rel="noopener" class="lead-wa-btn">
              📱 ${escapeHtmlDoc(l.phone)}
            </a>
          ` : `<span class="text-xs text-muted">📞 ${escapeHtmlDoc(l.phone || 'N/I')}</span>`}
        </td>
        <td>
          <strong>${escapeHtmlDoc(l.course_interest || 'Geral')}</strong>
          ${l.student_grade ? `<small class="text-muted" style="display:block;">${escapeHtmlDoc(l.student_grade)}</small>` : ''}
        </td>
        <td style="max-width:220px; font-size:0.8rem; color:#475569;">
          ${escapeHtmlDoc(l.message || l.notes || 'Sem observações')}
        </td>
        <td>
          ${isInKanban ? `
            <div style="display:inline-flex; align-items:center; gap:6px;">
              <span class="badge-kanban-status active" title="Este contato está visível no Funil Kanban">📌 No Kanban</span>
              <button type="button" class="btn-toggle-kanban remove" data-id="${l.id}" data-action="remove" title="Tirar do Kanban (mantém na lista geral)">Tirar</button>
            </div>
          ` : `
            <div style="display:inline-flex; align-items:center; gap:6px;">
              <span class="badge-kanban-status inbox" title="Aguardando triagem">📥 Caixa Entrada</span>
              <button type="button" class="btn-toggle-kanban add" data-id="${l.id}" data-action="add" title="Colocar este contato no Funil Kanban">➕ Pôr no Kanban</button>
            </div>
          `}
        </td>
        <td>
          <select class="select-lead-status-table" data-id="${l.id}" style="padding:4px 8px; border-radius:6px; border:1px solid #cbd5e1; font-size:0.8rem; font-weight:700;">
            <option value="novo" ${l.status === 'novo' ? 'selected' : ''}>🟡 Novo</option>
            <option value="contatado" ${l.status === 'contatado' ? 'selected' : ''}>💬 Em Atendimento</option>
            <option value="agendado" ${l.status === 'agendado' ? 'selected' : ''}>📅 Aula Experimental</option>
            <option value="matriculado" ${l.status === 'matriculado' ? 'selected' : ''}>🎉 Matriculado</option>
            <option value="arquivado" ${l.status === 'arquivado' ? 'selected' : ''}>⚪ Arquivado</option>
          </select>
        </td>
        <td style="white-space:nowrap;">
          <button type="button" class="btn-sm-action btn-edit-lead-table" data-id="${l.id}" style="background:#eff6ff; color:var(--brand-blue); border:none; padding:4px 8px; border-radius:6px; font-weight:700; cursor:pointer;" title="Editar Lead">
            ✏️
          </button>
          <button type="button" class="btn-sm-action btn-del-lead-table" data-id="${l.id}" style="background:#fee2e2; color:#dc2626; border:none; padding:4px 8px; border-radius:6px; font-weight:700; cursor:pointer; margin-left:4px;" title="Excluir">
            🗑️
          </button>
        </td>
      </tr>
    `;
  }).join('');

  bindTableInteractions();
}

function bindTableInteractions() {
  const tbody = document.getElementById('admin-leads-table-tbody');
  if (!tbody) return;

  // Botões de colocar / tirar do Kanban
  tbody.querySelectorAll('.btn-toggle-kanban').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const shouldAdd = btn.dataset.action === 'add';
      toggleLeadKanban(id, shouldAdd);
    });
  });

  // Select de status na tabela
  tbody.querySelectorAll('.select-lead-status-table').forEach(sel => {
    sel.addEventListener('change', () => {
      updateLeadStatus(sel.dataset.id, sel.value);
    });
  });

  // Botão de editar
  tbody.querySelectorAll('.btn-edit-lead-table').forEach(btn => {
    btn.addEventListener('click', () => openLeadModal(btn.dataset.id));
  });

  // Botão de excluir
  tbody.querySelectorAll('.btn-del-lead-table').forEach(btn => {
    btn.addEventListener('click', () => deleteLead(btn.dataset.id));
  });
}

async function toggleLeadKanban(leadId, addToKanban) {
  try {
    const res = await fetch(`${API_BASE}/api/leads/${leadId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ in_kanban: addToKanban })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao alterar presença no Kanban');

    const item = (state.adminLeads || []).find(l => String(l.id) === String(leadId));
    if (item) item.in_kanban = addToKanban;

    renderLeadsKanban();
    renderLeadsTable();

    showToast(addToKanban ? ' Lead adicionado ao Kanban!' : ' Lead retirado do Kanban (mantido na lista).');
  } catch (err) {
    showAppAlert(err.message, 'Funil Kanban');
  }
}

function bindKanbanInteractions() {
  const kanban = document.getElementById('leads-kanban');
  if (!kanban) return;

  // Drag & drop
  kanban.querySelectorAll('.lead-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      kanban.querySelectorAll('.kanban-col-body').forEach(b => b.classList.remove('drag-over'));
    });
  });

  kanban.querySelectorAll('.kanban-col-body').forEach(colBody => {
    colBody.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      colBody.classList.add('drag-over');
    });
    colBody.addEventListener('dragleave', (e) => {
      if (!colBody.contains(e.relatedTarget)) {
        colBody.classList.remove('drag-over');
      }
    });
    colBody.addEventListener('drop', async (e) => {
      e.preventDefault();
      colBody.classList.remove('drag-over');
      const leadId = e.dataTransfer.getData('text/plain');
      const targetStatus = colBody.dataset.status;
      if (!leadId || !targetStatus) return;

      const current = (state.adminLeads || []).find(l => String(l.id) === String(leadId));
      if (current && current.status === targetStatus) return;

      await updateLeadStatus(leadId, targetStatus);
    });
  });

  // Botão ✕ para tirar do Kanban diretamente do card
  kanban.querySelectorAll('.btn-lead-unkanban').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLeadKanban(btn.dataset.id, false);
    });
  });

  // Botões de navegação rápida de etapa (◀ e ▶)
  kanban.querySelectorAll('.btn-lead-step').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const leadId = btn.dataset.id;
      const target = btn.dataset.target;
      if (leadId && target) updateLeadStatus(leadId, target);
    });
  });

  // Botão de editar
  kanban.querySelectorAll('.btn-lead-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openLeadModal(btn.dataset.id);
    });
  });

  // Clique no título do card para editar
  kanban.querySelectorAll('.lead-card-title').forEach(titleEl => {
    titleEl.addEventListener('click', () => {
      const card = titleEl.closest('.lead-card');
      if (card) openLeadModal(card.dataset.id);
    });
  });

  // Botão de excluir
  kanban.querySelectorAll('.btn-lead-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteLead(btn.dataset.id);
    });
  });
}

function openLeadModal(leadId = null) {
  const modal = document.getElementById('modal-lead-admin');
  const form = document.getElementById('form-lead-admin');
  const title = document.getElementById('lead-modal-title');
  const delBtn = document.getElementById('btn-delete-lead');
  if (!modal || !form) return;

  form.reset();

  const inKanbanChk = document.getElementById('lead-in-kanban');

  if (leadId) {
    const lead = (state.adminLeads || []).find(l => String(l.id) === String(leadId));
    if (!lead) return;

    title.textContent = 'Editar Lead';
    document.getElementById('lead-edit-id').value = lead.id;
    document.getElementById('lead-name').value = lead.name || '';
    document.getElementById('lead-phone').value = lead.phone || '';
    document.getElementById('lead-email').value = lead.email || '';
    document.getElementById('lead-course').value = lead.course_interest || '';
    document.getElementById('lead-grade').value = lead.student_grade || '';
    document.getElementById('lead-source').value = lead.source || 'site';
    document.getElementById('lead-status').value = lead.status || 'novo';
    document.getElementById('lead-message').value = lead.message || '';
    document.getElementById('lead-notes').value = lead.notes || '';
    if (inKanbanChk) inKanbanChk.checked = Boolean(lead.in_kanban);
    if (delBtn) delBtn.classList.remove('hidden');
  } else {
    title.textContent = 'Novo Lead (Cadastro Manual)';
    document.getElementById('lead-edit-id').value = '';
    document.getElementById('lead-source').value = 'whatsapp';
    document.getElementById('lead-status').value = 'novo';
    if (inKanbanChk) inKanbanChk.checked = true;
    if (delBtn) delBtn.classList.add('hidden');
  }

  modal.classList.remove('hidden');
}

function closeLeadModal() {
  const modal = document.getElementById('modal-lead-admin');
  if (modal) modal.classList.add('hidden');
}

async function updateLeadStatus(leadId, newStatus) {
  try {
    const res = await fetch(`${API_BASE}/api/leads/${leadId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao atualizar etapa');
    
    // Atualiza otimista no state
    const item = (state.adminLeads || []).find(l => String(l.id) === String(leadId));
    if (item) item.status = newStatus;
    renderLeadsKanban();
    renderLeadsTable();
    showToast('Etapa do lead atualizada!');
  } catch (err) {
    showAppAlert(err.message, 'Atualizar Lead');
  }
}

async function deleteLead(leadId) {
  showAppConfirm('Tem certeza de que deseja remover este interessado?', async () => {
    try {
      const res = await fetch(`${API_BASE}/api/leads/${leadId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (!res.ok) throw new Error('Falha ao remover lead');
      showToast('Lead removido com sucesso.');
      closeLeadModal();
      loadAdminLeads();
    } catch (err) {
      showAppAlert(err.message, 'Remover Lead');
    }
  }, 'Excluir Lead', true);
}

function setupLeadsEvents() {
  const btnAdd = document.getElementById('btn-add-lead');
  if (btnAdd) btnAdd.addEventListener('click', () => openLeadModal(null));

  const btnClose = document.getElementById('btn-close-lead-modal');
  if (btnClose) btnClose.addEventListener('click', closeLeadModal);

  const btnCancel = document.getElementById('btn-cancel-lead');
  if (btnCancel) btnCancel.addEventListener('click', closeLeadModal);

  const btnDel = document.getElementById('btn-delete-lead');
  if (btnDel) {
    btnDel.addEventListener('click', () => {
      const id = document.getElementById('lead-edit-id').value;
      if (id) deleteLead(id);
    });
  }

  const searchInput = document.getElementById('input-leads-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      leadSearchQuery = e.target.value;
      renderLeadsKanban();
      renderLeadsTable();
    });
  }

  const sourceFilter = document.getElementById('select-leads-source-filter');
  if (sourceFilter) {
    sourceFilter.addEventListener('change', (e) => {
      leadSourceFilter = e.target.value;
      renderLeadsKanban();
      renderLeadsTable();
    });
  }

  const form = document.getElementById('form-lead-admin');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const editId = document.getElementById('lead-edit-id').value;
      const inKanbanChk = document.getElementById('lead-in-kanban');
      const payload = {
        name: document.getElementById('lead-name').value.trim(),
        phone: document.getElementById('lead-phone').value.trim(),
        email: document.getElementById('lead-email').value.trim() || null,
        course_interest: document.getElementById('lead-course').value.trim() || null,
        student_grade: document.getElementById('lead-grade').value.trim() || null,
        source: document.getElementById('lead-source').value,
        status: document.getElementById('lead-status').value,
        message: document.getElementById('lead-message').value.trim() || null,
        notes: document.getElementById('lead-notes').value.trim() || null,
        in_kanban: inKanbanChk ? inKanbanChk.checked : true
      };

      const url = editId ? `${API_BASE}/api/leads/${editId}` : `${API_BASE}/api/leads/manual`;
      const method = editId ? 'PATCH' : 'POST';

      try {
        const res = await fetch(url, {
          method,
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro ao salvar lead');

        showToast(editId ? 'Lead atualizado com sucesso!' : 'Lead cadastrado com sucesso!');
        closeLeadModal();
        loadAdminLeads();
      } catch (err) {
        showAppAlert(err.message, 'Cadastro de Lead');
      }
    });
  }
}

// Exportações e atalhos globais
window.showWebsite = showWebsite;
window.showLogin = showLogin;
window.showApp = showApp;
window.enrollCourseInquiry = enrollCourseInquiry;
window.toggleLessonProgress = toggleLessonProgress;
window.openLessonVideoModal = openLessonVideoModal;
window.openSubmitAssignmentModal = openSubmitAssignmentModal;
window.closeSubmitAssignmentModal = closeSubmitAssignmentModal;
window.openGradeAssignmentModal = openGradeAssignmentModal;
window.closeGradeAssignmentModal = closeGradeAssignmentModal;
window.openPixModal = openPixModal;
window.closePixModal = closePixModal;
window.printInvoiceReceipt = printInvoiceReceipt;
window.markInvoiceAsPaid = markInvoiceAsPaid;
window.cancelInvoice = cancelInvoice;
window.openNewInvoiceModal = openNewInvoiceModal;
window.closeNewInvoiceModal = closeNewInvoiceModal;
window.updateLeadStatus = updateLeadStatus;
window.deleteLead = deleteLead;
window.toggleLeadKanban = toggleLeadKanban;
window.openLeadModal = openLeadModal;

// =========================================================================
// 📋 RELATÓRIO DE ACOMPANHAMENTO PEDAGÓGICO (mesmas seções da ficha impressa)
// =========================================================================
const PED_FORM = {
  objectives: [
    ['leitura', 'Leitura'], ['interpretacao', 'Interpretação de texto'], ['producao_textual', 'Produção textual'],
    ['ortografia', 'Ortografia'], ['matematica', 'Matemática'], ['raciocinio_logico', 'Raciocínio lógico'],
    ['organizacao_estudos', 'Organização dos estudos'], ['enem_vestibulares', 'ENEM / Vestibulares'], ['outros', 'Outros']
  ],
  components: [
    ['portugues', 'Português'], ['matematica', 'Matemática'], ['interpretacao', 'Interpretação de Texto'],
    ['producao_textual', 'Produção Textual'], ['raciocinio_logico', 'Raciocínio Lógico'], ['outros', 'Outros']
  ],
  levels: [['otimo', 'Ótimo'], ['bom', 'Bom'], ['regular', 'Regular'], ['em_desenvolvimento', 'Em desenvolvimento']],
  aspects: [
    ['participacao', 'Participação'], ['concentracao', 'Concentração'], ['organizacao', 'Organização'],
    ['autonomia', 'Autonomia'], ['relacionamento', 'Relacionamento interpessoal'], ['persistencia', 'Persistência diante das dificuldades']
  ],
  strategies: [
    ['ludicas', 'Atividades lúdicas'], ['recursos_digitais', 'Recursos digitais'], ['lousa_digital', 'Lousa digital interativa'],
    ['exercicios_personalizados', 'Exercícios personalizados'], ['gamificacao', 'Gamificação'],
    ['acompanhamento_individualizado', 'Acompanhamento individualizado'], ['material_adaptado', 'Material adaptado'], ['outros', 'Outros']
  ],
  emotional: [
    ['aceita_orientacoes', 'Aceita orientações com facilidade'], ['necessita_redirecionamento', 'Necessita de redirecionamento em alguns momentos'],
    ['tolerancia_frustracao', 'Demonstra boa tolerância à frustração'], ['resistencia_inicial', 'Apresenta resistência inicial, mas conclui as atividades'],
    ['interage_respeitosa', 'Interage de forma respeitosa com colegas e professores'], ['outros', 'Outros']
  ]
};

const pedState = { student: null, reports: [] };

function pedLabel(list, key) {
  const found = PED_FORM[list].find(([k]) => k === key);
  return found ? found[1] : key;
}

async function openPedagogicalReports(studentId) {
  const modal = document.getElementById('modal-ped-report');
  const body = document.getElementById('ped-modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="loading-state">Carregando relatórios...</div>';
  try {
    const [studentData, reports] = await Promise.all([
      apiJson(`/api/students/${studentId}`),
      apiJson(`/api/students/${studentId}/pedagogical-reports`)
    ]);
    pedState.student = studentData.student || studentData;
    pedState.reports = reports;
    document.getElementById('ped-modal-title').textContent = pedState.student.name;
    renderPedList();
  } catch (err) {
    body.innerHTML = `<div class="text-danger">${escapeHtml(err.message)}</div>`;
  }
}

function pedCanEdit(report) {
  const u = state.currentUser;
  return u && (u.role === 'admin' || report.teacher_id === u.id);
}

function renderPedList() {
  const body = document.getElementById('ped-modal-body');
  const items = pedState.reports;
  if (pedState.student) {
    document.getElementById('ped-modal-title').textContent = pedState.student.name;
  }
  body.innerHTML = `
    <div class="ped-list-head">
      <p class="text-sm text-muted" style="margin:0;">Relatórios finalizados ficam visíveis para a família no Portal.</p>
      <button type="button" class="btn-primary-action" onclick="renderPedForm(null)"><span>➕ Novo relatório</span></button>
    </div>
    ${items.length === 0 ? '<div class="ped-empty">Nenhum relatório ainda para este aluno.</div>' : items.map(r => `
      <div class="ped-item">
        <div class="ped-item-main">
          <strong>Relatório de ${escapeHtml(r.report_date_br)}</strong>
          <span class="ped-status ${r.status}">${r.status === 'finalizado' ? '✅ Finalizado' : '📝 Rascunho'}</span>
          <small class="text-muted">
            ${r.period_start_br && r.period_end_br ? `Período ${r.period_start_br} a ${r.period_end_br} · ` : ''}
            ${r.lessons_count !== null && r.lessons_count !== undefined ? `${r.lessons_count} aula(s) · ` : ''}
            Prof. ${escapeHtml(r.teacher_display_name || '-')}
          </small>
        </div>
        <div class="ped-item-actions">
          <button type="button" class="btn-card-action primary" onclick="viewPedagogicalReportById(${r.id})">👁️ Visualizar</button>
          <button type="button" class="btn-card-action secondary" onclick="printPedagogicalReportById(${r.id})">🖨️ Imprimir</button>
          ${pedCanEdit(r) ? `
            <button type="button" class="btn-card-action secondary" onclick="renderPedForm(${r.id})">✏️ Editar</button>
            <button type="button" class="btn-card-action secondary" onclick="deletePedagogicalReport(${r.id})" aria-label="Excluir relatório">🗑️</button>
          ` : ''}
        </div>
      </div>
    `).join('')}
  `;
}

function pedChecks(name, list, selected, cols = 2) {
  return `<div class="ped-checks cols-${cols}">${PED_FORM[list].map(([key, label]) => `
    <label class="ped-check"><input type="checkbox" name="${name}" value="${key}" ${selected.includes(key) ? 'checked' : ''}> <span>${label}</span></label>
  `).join('')}</div>`;
}

function renderPedForm(reportId) {
  const r = reportId ? pedState.reports.find(x => x.id === reportId) : null;
  const st = pedState.student;
  const today = toIsoDateOnly(new Date());
  const firstOfMonth = today.slice(0, 8) + '01';
  const v = (field, fallback = '') => (r && r[field] !== null && r[field] !== undefined ? r[field] : fallback);
  const d = field => (r && r[field] ? toIsoDateOnly(r[field]) : '');
  const perf = (r && r.performance) || {};
  const teacherName = r ? (r.teacher_display_name || '') : (state.currentUser ? state.currentUser.name : '');
  const subjectsText = (st.subjects || []).map(s => s.name).join(', ');

  document.getElementById('ped-modal-body').innerHTML = `
    <form id="form-ped-report" class="ped-form" data-report-id="${r ? r.id : ''}">
      <div class="ped-card">
        <div class="ped-grid-3">
          <div class="form-group"><label>Aluno(a)</label><input type="text" value="${escapeHtml(st.name)}" disabled></div>
          <div class="form-group"><label for="ped-age">Idade</label><input type="text" id="ped-age" maxlength="30" placeholder="Ex.: 10 anos" value="${escapeHtml(v('student_age'))}"></div>
          <div class="form-group"><label for="ped-date">Data</label><input type="date" id="ped-date" value="${d('report_date') || today}"></div>
          <div class="form-group"><label>Professor(a)</label><input type="text" value="${escapeHtml(teacherName)}" disabled></div>
          <div class="form-group ped-span-2"><label for="ped-class">Turma / Horário</label><input type="text" id="ped-class" maxlength="150" placeholder="Ex.: Tarde · Matemática" value="${escapeHtml(v('class_info'))}"></div>
          <div class="form-group"><label for="ped-start">Período avaliado — de</label><input type="date" id="ped-start" value="${d('period_start') || (r ? '' : firstOfMonth)}"></div>
          <div class="form-group"><label for="ped-end">até</label><input type="date" id="ped-end" value="${d('period_end') || (r ? '' : today)}"></div>
          <div class="form-group"><label for="ped-lessons">Nº de aulas no período</label>
            <div class="ped-inline"><input type="number" id="ped-lessons" min="0" max="1000" value="${escapeHtml(v('lessons_count'))}"><button type="button" class="btn-link-action" id="ped-calc-lessons" title="Contar pelas aulas lançadas no diário">↻ Diário</button></div>
          </div>
        </div>
        ${subjectsText ? `<p class="text-xs text-muted" style="margin:6px 0 0;">Matérias matriculadas: ${escapeHtml(subjectsText)}</p>` : ''}
      </div>

      <div class="ped-two">
        <section class="ped-card">
          <h3>🎯 1. Objetivos trabalhados</h3>
          ${pedChecks('ped-objectives', 'objectives', v('objectives', []), 1)}
          <input type="text" id="ped-objectives-other" class="ped-other" maxlength="200" placeholder="Outros: quais?" value="${escapeHtml(v('objectives_other'))}">
        </section>
        <section class="ped-card">
          <h3>📖 2. Desenvolvimento acadêmico</h3>
          <p class="ped-hint">Descrever os conteúdos trabalhados e o desempenho do aluno durante o período.</p>
          <textarea id="ped-development" rows="9">${escapeHtml(v('academic_development'))}</textarea>
        </section>
      </div>

      <div class="ped-two">
        <section class="ped-card">
          <h3>👤 3. Desempenho acadêmico</h3>
          <p class="ped-hint">Avaliação geral por componente</p>
          <div class="ped-table-wrap">
            <table class="ped-table">
              <thead><tr><th>Componente</th>${PED_FORM.levels.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
              <tbody>
                ${PED_FORM.components.map(([key, label]) => `
                  <tr>
                    <td>${key === 'outros' ? `<input type="text" id="ped-perf-other-label" maxlength="100" placeholder="Outros" value="${escapeHtml(v('performance_other_label'))}">` : label}</td>
                    ${PED_FORM.levels.map(([lv]) => `<td><input type="radio" name="ped-perf-${key}" value="${lv}" ${perf[key] === lv ? 'checked' : ''} aria-label="${label}: ${lv}"></td>`).join('')}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <label class="ped-label">Observações acadêmicas</label>
          <textarea id="ped-academic-notes" rows="3">${escapeHtml(v('academic_notes'))}</textarea>
        </section>
        <section class="ped-card">
          <h3>💙 4. Aspectos comportamentais e socioemocionais</h3>
          <p class="ped-hint">Avaliação geral dos aspectos observados</p>
          <div class="ped-radios">
            ${PED_FORM.levels.map(([lv, l]) => `<label class="ped-check"><input type="radio" name="ped-behavior" value="${lv}" ${v('behavior_overall') === lv ? 'checked' : ''}> <span>${l}</span></label>`).join('')}
          </div>
          <label class="ped-label">Aspectos observados</label>
          ${pedChecks('ped-aspects', 'aspects', v('behavior_aspects', []), 2)}
          <label class="ped-label">Observações</label>
          <textarea id="ped-behavior-notes" rows="3">${escapeHtml(v('behavior_notes'))}</textarea>
        </section>
      </div>

      <div class="ped-two">
        <section class="ped-card">
          <h3>⚙️ 5. Estratégias utilizadas</h3>
          ${pedChecks('ped-strategies', 'strategies', v('strategies', []), 2)}
          <input type="text" id="ped-strategies-other" class="ped-other" maxlength="200" placeholder="Outros: quais?" value="${escapeHtml(v('strategies_other'))}">
        </section>
        <section class="ped-card">
          <h3>📈 6. Evolução observada</h3>
          <p class="ped-hint">Descrever os avanços percebidos desde o início ou em relação ao último relatório.</p>
          <textarea id="ped-evolution" rows="6">${escapeHtml(v('evolution'))}</textarea>
        </section>
      </div>

      <section class="ped-card">
        <h3>🙂 7. Regulação emocional e comportamento durante as aulas</h3>
        <p class="ped-hint">Comportamentos observados com maior frequência</p>
        ${pedChecks('ped-emotional', 'emotional', v('emotional_behaviors', []), 2)}
        <input type="text" id="ped-emotional-other" class="ped-other" maxlength="200" placeholder="Outros: quais?" value="${escapeHtml(v('emotional_other'))}">
        <label class="ped-label">Observações adicionais</label>
        <textarea id="ped-emotional-notes" rows="2">${escapeHtml(v('emotional_notes'))}</textarea>
      </section>

      <div class="ped-three">
        <section class="ped-card">
          <h3>👨‍👩‍👧 8. Recomendações para a família</h3>
          <textarea id="ped-family" rows="4">${escapeHtml(v('family_recommendations'))}</textarea>
        </section>
        <section class="ped-card">
          <h3>🏫 9. Sugestões para a escola</h3>
          <p class="ped-hint">(Quando autorizado pela família)</p>
          <textarea id="ped-school" rows="3">${escapeHtml(v('school_suggestions'))}</textarea>
        </section>
        <section class="ped-card">
          <h3>⭐ 10. Considerações finais</h3>
          <textarea id="ped-final" rows="4">${escapeHtml(v('final_considerations'))}</textarea>
        </section>
      </div>

      <div class="ped-actions">
        <button type="button" class="btn-link-action" id="ped-back">← Voltar</button>
        <div class="ped-actions-right">
          <button type="button" class="btn-card-action secondary" data-ped-status="rascunho">💾 Salvar rascunho</button>
          <button type="button" class="btn-primary-action" data-ped-status="finalizado"><span>✅ Finalizar relatório</span></button>
        </div>
      </div>
    </form>
  `;

  const form = document.getElementById('form-ped-report');
  // Evita perder o preenchimento ao voltar sem salvar
  let dirty = false;
  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('change', () => { dirty = true; });
  document.getElementById('ped-back').addEventListener('click', () => {
    if (!dirty) return renderPedList();
    showAppConfirm('Há alterações não salvas neste relatório. Deseja descartá-las?', renderPedList, 'Descartar alterações', true);
  });
  form.querySelectorAll('[data-ped-status]').forEach(btn => {
    btn.addEventListener('click', () => submitPedagogicalReport(btn.getAttribute('data-ped-status')));
  });
  document.getElementById('ped-calc-lessons').addEventListener('click', () => suggestPedHeader(true));
  ['ped-start', 'ped-end'].forEach(id => document.getElementById(id).addEventListener('change', () => suggestPedHeader(false)));
  if (!r) suggestPedHeader(false);
  document.getElementById('ped-modal-body').scrollTop = 0;
}

// Preenche nº de aulas (pelo diário) e turma/horário (pela grade) quando estiverem vazios
async function suggestPedHeader(forceLessons) {
  const start = document.getElementById('ped-start').value;
  const end = document.getElementById('ped-end').value;
  try {
    const s = await apiJson(`/api/students/${pedState.student.id}/pedagogical-reports/suggestion?period_start=${start}&period_end=${end}`);
    const lessons = document.getElementById('ped-lessons');
    if (s.lessons_count !== null && (forceLessons || lessons.value === '')) lessons.value = s.lessons_count;
    const cls = document.getElementById('ped-class');
    if (s.class_info && !cls.value) cls.value = s.class_info;
    if (forceLessons) showToast(`${s.lessons_count ?? 0} aula(s) lançada(s) no diário neste período.`);
  } catch (err) {
    if (forceLessons) showAppAlert(err.message, 'Relatório Pedagógico');
  }
}

function collectPedPayload(status) {
  const checked = name => Array.from(document.querySelectorAll(`#form-ped-report input[name="${name}"]:checked`)).map(i => i.value);
  const val = id => document.getElementById(id).value.trim();
  const performance = {};
  PED_FORM.components.forEach(([key]) => {
    const sel = document.querySelector(`#form-ped-report input[name="ped-perf-${key}"]:checked`);
    if (sel) performance[key] = sel.value;
  });
  const behavior = document.querySelector('#form-ped-report input[name="ped-behavior"]:checked');
  const objectives = checked('ped-objectives');
  const strategies = checked('ped-strategies');
  const emotional = checked('ped-emotional');
  // Texto em "Outros" marca a opção automaticamente
  if (val('ped-objectives-other') && !objectives.includes('outros')) objectives.push('outros');
  if (val('ped-strategies-other') && !strategies.includes('outros')) strategies.push('outros');
  if (val('ped-emotional-other') && !emotional.includes('outros')) emotional.push('outros');
  return {
    status,
    student_age: val('ped-age'),
    report_date: val('ped-date'),
    class_info: val('ped-class'),
    period_start: val('ped-start') || null,
    period_end: val('ped-end') || null,
    lessons_count: val('ped-lessons'),
    objectives,
    objectives_other: val('ped-objectives-other'),
    academic_development: val('ped-development'),
    performance,
    performance_other_label: val('ped-perf-other-label'),
    academic_notes: val('ped-academic-notes'),
    behavior_overall: behavior ? behavior.value : null,
    behavior_aspects: checked('ped-aspects'),
    behavior_notes: val('ped-behavior-notes'),
    strategies,
    strategies_other: val('ped-strategies-other'),
    evolution: val('ped-evolution'),
    emotional_behaviors: emotional,
    emotional_other: val('ped-emotional-other'),
    emotional_notes: val('ped-emotional-notes'),
    family_recommendations: val('ped-family'),
    school_suggestions: val('ped-school'),
    final_considerations: val('ped-final')
  };
}

async function submitPedagogicalReport(status) {
  const form = document.getElementById('form-ped-report');
  const reportId = form.getAttribute('data-report-id');
  const doSave = async () => {
    try {
      const data = await apiJson(reportId ? `/api/pedagogical-reports/${reportId}` : `/api/students/${pedState.student.id}/pedagogical-reports`, {
        method: reportId ? 'PUT' : 'POST',
        body: JSON.stringify(collectPedPayload(status))
      });
      showToast(data.message);
      pedState.reports = await apiJson(`/api/students/${pedState.student.id}/pedagogical-reports`);
      renderPedList();
      refreshReportPedSectionIfOpen();
    } catch (err) {
      showAppAlert(err.message, 'Relatório Pedagógico');
    }
  };
  if (status === 'finalizado') {
    showAppConfirm('Ao finalizar, o relatório fica visível para a família no Portal. Você ainda poderá editá-lo depois. Deseja finalizar?', doSave, 'Finalizar Relatório');
  } else {
    doSave();
  }
}

function deletePedagogicalReport(reportId) {
  showAppConfirm('Excluir este relatório? Esta ação não pode ser desfeita.', async () => {
    try {
      await apiJson(`/api/pedagogical-reports/${reportId}`, { method: 'DELETE' });
      showToast('Relatório excluído.');
      pedState.reports = pedState.reports.filter(r => r.id !== reportId);
      renderPedList();
      refreshReportPedSectionIfOpen();
    } catch (err) {
      showAppAlert(err.message, 'Excluir Relatório');
    }
  }, 'Excluir Relatório', true);
}

// Abre a ficha em um painel/modal completo e estilizado para visualização
async function viewPedagogicalReportById(reportId, studentId = null) {
  const modal = document.getElementById('modal-ped-report');
  const body = document.getElementById('ped-modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="loading-state" style="padding:40px; text-align:center;">Carregando relatório pedagógico...</div>';
  body.scrollTop = 0;

  try {
    const report = await apiJson(`/api/pedagogical-reports/${reportId}`);
    const sId = studentId || report.student_id;
    if (!pedState.student || pedState.student.id !== sId) {
      try {
        const [studentData, reports] = await Promise.all([
          apiJson(`/api/students/${sId}`),
          apiJson(`/api/students/${sId}/pedagogical-reports`)
        ]);
        pedState.student = studentData.student || studentData;
        pedState.reports = reports;
      } catch (e) {
        pedState.student = { id: report.student_id, name: report.student_name };
      }
    } else if (!pedState.reports || pedState.reports.length === 0) {
      try {
        pedState.reports = await apiJson(`/api/students/${sId}/pedagogical-reports`);
      } catch (e) {}
    }

    document.getElementById('ped-modal-title').textContent = `${report.student_name} · Ficha Pedagógica`;
    renderPedView(report);
  } catch (err) {
    body.innerHTML = `
      <div style="padding:24px;">
        <div class="text-danger" style="margin-bottom:12px;">${escapeHtml(err.message)}</div>
        <button type="button" class="btn-card-action secondary" onclick="renderPedList()">← Voltar</button>
      </div>
    `;
  }
}

// Renderiza a visualização rica da ficha pedagógica (estilo relatório impresso moderno)
function renderPedView(r) {
  const body = document.getElementById('ped-modal-body');
  const txt = t => (t && t.trim() ? escapeHtml(t).replace(/\n/g, '<br>') : '');
  const perf = r.performance || {};
  const logo = '/img/logo-entrelinhas.svg';
  const canEdit = pedCanEdit(r);

  // Helper para pills de listas de opções
  const renderPills = (list, selectedKeys, otherVal) => {
    const keys = selectedKeys || [];
    if (!keys.length && !otherVal) {
      return '<div class="ped-view-empty-hint">Nenhum item assinalado no período.</div>';
    }
    const pills = keys.map(k => {
      const label = pedLabel(list, k);
      if (k === 'outros' && otherVal) {
        return `<span class="ped-view-pill highlighted">✓ Outros: <strong>${escapeHtml(otherVal)}</strong></span>`;
      }
      return `<span class="ped-view-pill active">✓ ${escapeHtml(label)}</span>`;
    });
    return `<div class="ped-view-pills">${pills.join('')}</div>`;
  };

  // Helper para níveis de desempenho (com ícone e estilo)
  const levelBadge = lv => {
    if (!lv) return '<span class="ped-level-badge none">—</span>';
    const label = pedLabel('levels', lv);
    const icons = { otimo: '⭐', bom: '👍', regular: '⚠️', em_desenvolvimento: '🌱' };
    return `<span class="ped-level-badge ${lv}"><span class="badge-ico">${icons[lv] || '•'}</span> ${escapeHtml(label)}</span>`;
  };

  // Tabela com os 4 níveis visuais (Ótimo, Bom, Regular, Em desenvolvimento)
  const perfTableHtml = `
    <div class="ped-view-table-wrap">
      <table class="ped-view-table">
        <thead>
          <tr>
            <th>Componente Curricular</th>
            ${PED_FORM.levels.map(([k, l]) => `<th class="th-level col-center">${escapeHtml(l)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${PED_FORM.components.map(([k, l]) => {
            const rowLabel = (k === 'outros' && r.performance_other_label) ? `Outros: ${escapeHtml(r.performance_other_label)}` : l;
            const currentLv = perf[k];
            return `
              <tr class="${currentLv ? 'has-eval' : ''}">
                <td class="td-component"><strong>${rowLabel}</strong></td>
                ${PED_FORM.levels.map(([lv]) => `
                  <td class="col-center td-level-cell ${currentLv === lv ? 'selected ' + lv : ''}">
                    ${currentLv === lv ? `<span class="ped-level-check">${levelBadge(lv)}</span>` : '<span class="ped-cell-empty">·</span>'}
                  </td>
                `).join('')}
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Avaliação Geral do Comportamento em pílulas horizontais
  const behaviorOverallHtml = `
    <div class="ped-view-overall-box">
      <span class="ped-overall-label">Avaliação geral:</span>
      <div class="ped-overall-pills">
        ${PED_FORM.levels.map(([lv, l]) => `
          <span class="ped-overall-pill ${r.behavior_overall === lv ? 'active ' + lv : 'inactive'}">
            ${r.behavior_overall === lv ? '✓ ' : ''}${l}
          </span>
        `).join('')}
      </div>
    </div>
  `;

  body.innerHTML = `
    <div class="ped-view-wrapper">
      <!-- Toolbar superior de navegação -->
      <div class="ped-view-toolbar">
        <button type="button" class="btn-card-action secondary" onclick="renderPedList()" title="Voltar para a lista de relatórios">
          <span style="font-size:1.1rem; line-height:1;">←</span> Voltar à Lista
        </button>
        <div class="ped-view-toolbar-right">
          <span class="ped-status ${r.status}">${r.status === 'finalizado' ? '✅ Finalizado' : '📝 Rascunho'}</span>
          <button type="button" class="btn-card-action secondary" onclick="printPedagogicalReportById(${r.id})">
            🖨️ Imprimir / PDF
          </button>
          ${canEdit ? `
            <button type="button" class="btn-card-action primary" onclick="renderPedForm(${r.id})">
              ✏️ Editar Relatório
            </button>
          ` : ''}
        </div>
      </div>

      <!-- Documento visual / Ficha Pedagógica -->
      <div class="ped-view-doc">
        <!-- Banner Institucional Entrelinhas -->
        <div class="ped-view-doc-header">
          <div class="ped-view-brand">
            <img src="${logo}" alt="Entrelinhas" class="ped-view-logo" onerror="this.style.display='none'">
            <div class="ped-view-brand-sep"></div>
            <div>
              <h1 class="ped-view-title">RELATÓRIO DE ACOMPANHAMENTO PEDAGÓGICO</h1>
              <p class="ped-view-subtitle">Acompanhamento individualizado para potencializar resultados e desenvolver todo o potencial do aluno.</p>
            </div>
          </div>
          <div class="ped-view-header-badge">
            <span class="ped-status ${r.status}">${r.status === 'finalizado' ? '✅ Finalizado' : '📝 Rascunho'}</span>
          </div>
        </div>

        <!-- Metadados / Dados do Aluno -->
        <div class="ped-view-meta">
          <div class="ped-meta-item">
            <span class="ped-meta-label">Aluno(a)</span>
            <span class="ped-meta-value highlight">${escapeHtml(r.student_name)}</span>
          </div>
          <div class="ped-meta-item">
            <span class="ped-meta-label">Idade</span>
            <span class="ped-meta-value">${escapeHtml(r.student_age || 'Não informada')}</span>
          </div>
          <div class="ped-meta-item">
            <span class="ped-meta-label">Data da Ficha</span>
            <span class="ped-meta-value">${r.report_date_br || '-'}</span>
          </div>
          <div class="ped-meta-item">
            <span class="ped-meta-label">Professor(a)</span>
            <span class="ped-meta-value">${escapeHtml(r.teacher_display_name || '-')}</span>
          </div>
          <div class="ped-meta-item ped-span-2">
            <span class="ped-meta-label">Turma / Horário</span>
            <span class="ped-meta-value">${escapeHtml(r.class_info || '-')}</span>
          </div>
          <div class="ped-meta-item ped-span-2">
            <span class="ped-meta-label">Período Avaliado</span>
            <span class="ped-meta-value">${r.period_start_br || '__/__/____'} até ${r.period_end_br || '__/__/____'}</span>
          </div>
          <div class="ped-meta-item">
            <span class="ped-meta-label">Aulas no Período</span>
            <span class="ped-meta-value">${r.lessons_count !== null && r.lessons_count !== undefined ? `${r.lessons_count} aula(s)` : '-'}</span>
          </div>
        </div>

        <!-- Seções 1 e 2 -->
        <div class="ped-view-grid-2">
          <!-- 1. Objetivos Trabalhados -->
          <div class="ped-view-card">
            <div class="ped-view-card-head">
              <span class="ped-view-sec-num">1</span>
              <div>
                <h4>Objetivos Trabalhados</h4>
                <p class="ped-view-hint">Competências e áreas focadas durante o acompanhamento</p>
              </div>
            </div>
            <div class="ped-view-card-body">
              ${renderPills('objectives', r.objectives, r.objectives_other)}
            </div>
          </div>

          <!-- 2. Desenvolvimento Acadêmico -->
          <div class="ped-view-card">
            <div class="ped-view-card-head">
              <span class="ped-view-sec-num">2</span>
              <div>
                <h4>Desenvolvimento Acadêmico</h4>
                <p class="ped-view-hint">Conteúdos trabalhados e desempenho do aluno durante o período</p>
              </div>
            </div>
            <div class="ped-view-card-body">
              ${r.academic_development ? `
                <div class="ped-view-text-block academic">
                  ${txt(r.academic_development)}
                </div>
              ` : '<div class="ped-view-empty-hint">Nenhuma observação descrita.</div>'}
            </div>
          </div>
        </div>

        <!-- Seções 3 e 4 -->
        <div class="ped-view-grid-2">
          <!-- 3. Desempenho Acadêmico -->
          <div class="ped-view-card">
            <div class="ped-view-card-head">
              <span class="ped-view-sec-num">3</span>
              <div>
                <h4>Desempenho Acadêmico</h4>
                <p class="ped-view-hint">Avaliação geral por componente curricular</p>
              </div>
            </div>
            <div class="ped-view-card-body">
              ${perfTableHtml}
              ${r.academic_notes ? `
                <div class="ped-view-subnote">
                  <strong>Observações acadêmicas:</strong>
                  <div class="ped-view-text-block subnote">${txt(r.academic_notes)}</div>
                </div>
              ` : ''}
            </div>
          </div>

          <!-- 4. Aspectos Comportamentais e Socioemocionais -->
          <div class="ped-view-card">
            <div class="ped-view-card-head">
              <span class="ped-view-sec-num">4</span>
              <div>
                <h4>Aspectos Comportamentais e Socioemocionais</h4>
                <p class="ped-view-hint">Avaliação do comportamento, foco e interação</p>
              </div>
            </div>
            <div class="ped-view-card-body">
              ${behaviorOverallHtml}
              <div style="margin-top:14px;">
                <span class="ped-sub-label">Aspectos observados:</span>
                ${renderPills('aspects', r.behavior_aspects)}
              </div>
              ${r.behavior_notes ? `
                <div class="ped-view-subnote">
                  <strong>Observações comportamentais:</strong>
                  <div class="ped-view-text-block subnote">${txt(r.behavior_notes)}</div>
                </div>
              ` : ''}
            </div>
          </div>
        </div>

        <!-- Seções 5 e 6 -->
        <div class="ped-view-grid-2">
          <!-- 5. Estratégias Utilizadas -->
          <div class="ped-view-card">
            <div class="ped-view-card-head">
              <span class="ped-view-sec-num">5</span>
              <div>
                <h4>Estratégias Utilizadas</h4>
                <p class="ped-view-hint">Metodologias e recursos aplicados pelo professor</p>
              </div>
            </div>
            <div class="ped-view-card-body">
              ${renderPills('strategies', r.strategies, r.strategies_other)}
            </div>
          </div>

          <!-- 6. Evolução Observada -->
          <div class="ped-view-card">
            <div class="ped-view-card-head">
              <span class="ped-view-sec-num">6</span>
              <div>
                <h4>Evolução Observada</h4>
                <p class="ped-view-hint">Avanços percebidos desde o início ou em relação ao último relatório</p>
              </div>
            </div>
            <div class="ped-view-card-body">
              ${r.evolution ? `
                <div class="ped-view-text-block evolution">
                  ${txt(r.evolution)}
                </div>
              ` : '<div class="ped-view-empty-hint">Nenhuma evolução descrita.</div>'}
            </div>
          </div>
        </div>

        <!-- Seção 7: Regulação Emocional -->
        <div class="ped-view-card">
          <div class="ped-view-card-head">
            <span class="ped-view-sec-num">7</span>
            <div>
              <h4>Regulação Emocional e Comportamento Durante as Aulas</h4>
              <p class="ped-view-hint">Comportamentos observados com maior frequência no cotidiano pedagógico</p>
            </div>
          </div>
          <div class="ped-view-card-body">
            ${renderPills('emotional', r.emotional_behaviors, r.emotional_other)}
            ${r.emotional_notes ? `
              <div class="ped-view-subnote">
                <strong>Observações adicionais de regulação emocional:</strong>
                <div class="ped-view-text-block subnote">${txt(r.emotional_notes)}</div>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Seções 8, 9 e 10 -->
        <div class="ped-view-grid-3">
          <!-- 8. Recomendações para a Família -->
          <div class="ped-view-card family-card">
            <div class="ped-view-card-head">
              <span class="ped-view-sec-num">8</span>
              <div>
                <h4>Para a Família</h4>
                <p class="ped-view-hint">Orientações para o ambiente familiar</p>
              </div>
            </div>
            <div class="ped-view-card-body">
              ${r.family_recommendations ? `
                <div class="ped-view-text-block family">${txt(r.family_recommendations)}</div>
              ` : '<div class="ped-view-empty-hint">Sem recomendações específicas.</div>'}
            </div>
          </div>

          <!-- 9. Sugestões para a Escola -->
          <div class="ped-view-card school-card">
            <div class="ped-view-card-head">
              <span class="ped-view-sec-num">9</span>
              <div>
                <h4>Para a Escola</h4>
                <p class="ped-view-hint">Quando autorizado pela família</p>
              </div>
            </div>
            <div class="ped-view-card-body">
              ${r.school_suggestions ? `
                <div class="ped-view-text-block school">${txt(r.school_suggestions)}</div>
              ` : '<div class="ped-view-empty-hint">Nenhuma sugestão registrada.</div>'}
            </div>
          </div>

          <!-- 10. Considerações Finais -->
          <div class="ped-view-card final-card">
            <div class="ped-view-card-head">
              <span class="ped-view-sec-num">10</span>
              <div>
                <h4>Considerações Finais</h4>
                <p class="ped-view-hint">Síntese pedagógica do período</p>
              </div>
            </div>
            <div class="ped-view-card-body">
              ${r.final_considerations ? `
                <div class="ped-view-text-block final">${txt(r.final_considerations)}</div>
              ` : '<div class="ped-view-empty-hint">Sem considerações adicionais.</div>'}
            </div>
          </div>
        </div>

        <!-- Assinaturas e Rodapé da Escola -->
        <div class="ped-view-signatures">
          <div class="ped-sign-box">
            <div class="ped-sign-line"></div>
            <strong>Prof(a). ${escapeHtml(r.teacher_display_name || '-')}</strong>
            <small>Professor(a) Responsável</small>
          </div>
          <div class="ped-sign-box">
            <div class="ped-sign-line"></div>
            <strong>${r.report_date_br || '-'}</strong>
            <small>Data da Emissão</small>
          </div>
        </div>

        <div class="ped-view-footer-contacts">
          <span>📍 Rua Porto Alegre, 401 · Centro de Camboriú</span>
          <span>📱 (47) 99607-2036</span>
          <span>✉️ comercial@entrelinhas.online</span>
        </div>
      </div>

      <!-- Barra de Ações Inferior -->
      <div class="ped-view-bottom-bar">
        <button type="button" class="btn-card-action secondary" onclick="renderPedList()">
          <span style="font-size:1.1rem; line-height:1;">←</span> Voltar à Lista
        </button>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" class="btn-card-action secondary" onclick="printPedagogicalReportById(${r.id})">
            🖨️ Imprimir / PDF
          </button>
          ${canEdit ? `
            <button type="button" class="btn-card-action primary" onclick="renderPedForm(${r.id})">
              ✏️ Editar Relatório
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;

  body.scrollTop = 0;
}

async function printPedagogicalReportById(reportId) {
  try {
    const report = await apiJson(`/api/pedagogical-reports/${reportId}`);
    printPedagogicalReport(report);
  } catch (err) {
    showAppAlert(err.message, 'Imprimir Relatório');
  }
}

// Versão para impressão / PDF no layout da ficha oficial
function printPedagogicalReport(r) {
  const box = on => (on ? '☑' : '☐');
  const radio = on => `<span class="rb${on ? ' on' : ''}"></span>`;
  const sel = (list, selected) => PED_FORM[list].map(([k, l]) =>
    `<div class="opt">${box((selected || []).includes(k))} ${l}${k === 'outros' && r[`${list === 'objectives' ? 'objectives' : list === 'strategies' ? 'strategies' : 'emotional'}_other`] ? `: <u>${escapeHtml(r[`${list === 'objectives' ? 'objectives' : list === 'strategies' ? 'strategies' : 'emotional'}_other`])}</u>` : ''}</div>`
  ).join('');
  const txt = t => (t ? escapeHtml(t).replace(/\n/g, '<br>') : '<span class="blank"></span>');
  const perf = r.performance || {};
  // Usa o logotipo oficial azul e laranja para fundo claro/papel impresso
  const logo = `${window.location.origin}/img/logo-entrelinhas-dark.svg`;

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
  <title>Relatório Pedagógico - ${escapeHtml(r.student_name)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Outfit:wght@700;800&display=swap" rel="stylesheet">
  <style>
    @page { size: A4; margin: 10mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body { font-family: Inter, Arial, sans-serif; color: #111; font-size: 10.5px; margin: 0; }
    .head { display: flex; align-items: center; gap: 18px; background: #f8fafc; border: 1.5px solid #0e2970; color: #0e2970; padding: 12px 18px; border-radius: 6px; }
    .head img { height: 48px; width: auto; }
    .head .sep { width: 2px; align-self: stretch; background: #0e2970; opacity: 0.35; }
    .head h1 { font-family: Outfit, sans-serif; font-size: 19px; margin: 0; line-height: 1.15; letter-spacing: .5px; color: #0e2970; font-weight: 800; }
    .head p { margin: 4px 0 0; font-size: 9.5px; color: #475569; }
    .box { border: 1px solid #bbb; border-radius: 8px; padding: 9px 12px; margin-top: 8px; break-inside: avoid; }
    .row { display: grid; gap: 8px 18px; }
    .r2 { grid-template-columns: 1fr 1fr; } .r3 { grid-template-columns: 1fr 1fr 1fr; }
    .f b { text-transform: uppercase; font-size: 9.5px; color: #0e2970; } .f span { border-bottom: 1px solid #999; padding: 0 4px; }
    h2 { font-family: Outfit, sans-serif; font-size: 12px; margin: 0 0 5px; text-transform: uppercase; color: #0e2970; }
    .hint { color: #555; font-size: 9.5px; margin: 0 0 4px; }
    .opt { margin: 2px 0; } .opts2 { display: grid; grid-template-columns: 1fr 1fr; }
    .rb { display: inline-block; width: 10px; height: 10px; border: 1.5px solid #333; border-radius: 50%; vertical-align: -1px; margin-right: 3px; }
    .rb.on { background: radial-gradient(circle, #0e2970 45%, transparent 50%); }
    .text { min-height: 34px; line-height: 1.5; white-space: normal; }
    .blank { display: block; border-bottom: 1px solid #ccc; height: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 9.5px; }
    th, td { border: 1px solid #bbb; padding: 3px 5px; text-align: center; } th { background: #f1f5f9; color: #1e293b; font-weight: 700; } td:first-child { text-align: left; }
    .foot { display: flex; justify-content: space-around; margin-top: 10px; background: #f8fafc; border: 1px solid #cbd5e1; color: #1e293b; padding: 7px; border-radius: 6px; font-size: 9px; font-weight: 600; }
    .sign { display: flex; justify-content: space-between; margin-top: 14px; gap: 30px; }
    .sign div { flex: 1; border-top: 1px solid #333; padding-top: 4px; text-align: center; }
  </style></head><body>
  <div class="head"><img src="${logo}" alt="Entrelinhas"><div class="sep"></div>
    <div><h1>RELATÓRIO DE<br>ACOMPANHAMENTO PEDAGÓGICO</h1><p>Acompanhamento individualizado para potencializar resultados e desenvolver todo o potencial do aluno.</p></div></div>

  <div class="box row r3">
    <div class="f"><b>Aluno(a):</b> <span>${escapeHtml(r.student_name)}</span></div>
    <div class="f"><b>Idade:</b> <span>${escapeHtml(r.student_age || '')}</span></div>
    <div class="f"><b>Data:</b> <span>${r.report_date_br || ''}</span></div>
    <div class="f"><b>Professor(a):</b> <span>${escapeHtml(r.teacher_display_name || '')}</span></div>
    <div class="f" style="grid-column: span 2;"><b>Turma / Horário:</b> <span>${escapeHtml(r.class_info || '')}</span></div>
    <div class="f" style="grid-column: span 2;"><b>Período avaliado:</b> <span>${r.period_start_br || '__/__/____'} a ${r.period_end_br || '__/__/____'}</span></div>
    <div class="f"><b>Nº de aulas no período:</b> <span>${r.lessons_count ?? ''}</span></div>
  </div>

  <div class="row r2">
    <div class="box"><h2>1. Objetivos trabalhados</h2>${sel('objectives', r.objectives)}</div>
    <div class="box"><h2>2. Desenvolvimento acadêmico</h2><p class="hint">Descrever os conteúdos trabalhados e o desempenho do aluno durante o período.</p><div class="text">${txt(r.academic_development)}</div></div>
  </div>

  <div class="row r2">
    <div class="box"><h2>3. Desempenho acadêmico</h2><p class="hint">Avaliação geral por componente</p>
      <table><tr><th>Componente</th>${PED_FORM.levels.map(([, l]) => `<th>${l}</th>`).join('')}</tr>
      ${PED_FORM.components.map(([k, l]) => `<tr><td>${k === 'outros' && r.performance_other_label ? `Outros: ${escapeHtml(r.performance_other_label)}` : l}</td>${PED_FORM.levels.map(([lv]) => `<td>${perf[k] === lv ? '✕' : ''}</td>`).join('')}</tr>`).join('')}
      </table>
      <p class="hint" style="margin-top:6px;">Observações acadêmicas:</p><div class="text">${txt(r.academic_notes)}</div></div>
    <div class="box"><h2>4. Aspectos comportamentais e socioemocionais</h2><p class="hint">Avaliação geral dos aspectos observados</p>
      <div>${PED_FORM.levels.map(([lv, l]) => `${radio(r.behavior_overall === lv)} ${l}`).join(' &nbsp; ')}</div>
      <p class="hint" style="margin-top:6px;">Aspectos observados:</p><div class="opts2">${sel('aspects', r.behavior_aspects)}</div>
      <p class="hint" style="margin-top:6px;">Observações:</p><div class="text">${txt(r.behavior_notes)}</div></div>
  </div>

  <div class="row r2">
    <div class="box"><h2>5. Estratégias utilizadas</h2><div class="opts2">${sel('strategies', r.strategies)}</div></div>
    <div class="box"><h2>6. Evolução observada</h2><p class="hint">Descrever os avanços percebidos desde o início ou em relação ao último relatório.</p><div class="text">${txt(r.evolution)}</div></div>
  </div>

  <div class="box"><h2>7. Regulação emocional e comportamento durante as aulas</h2><p class="hint">Comportamentos observados com maior frequência:</p>
    <div class="opts2">${sel('emotional', r.emotional_behaviors)}</div>
    <p class="hint" style="margin-top:6px;">Observações adicionais:</p><div class="text">${txt(r.emotional_notes)}</div></div>

  <div class="row r3">
    <div class="box"><h2>8. Recomendações para a família</h2><div class="text">${txt(r.family_recommendations)}</div></div>
    <div class="box"><h2>9. Sugestões para a escola</h2><p class="hint">(Quando autorizado pela família)</p><div class="text">${txt(r.school_suggestions)}</div></div>
    <div class="box"><h2>10. Considerações finais</h2><div class="text">${txt(r.final_considerations)}</div></div>
  </div>

  <div class="sign"><div>Professor(a): ${escapeHtml(r.teacher_display_name || '')}</div><div>Data: ${r.report_date_br || ''}</div></div>
  <div class="foot"><span>📍 Rua Porto Alegre, 401 · Centro de Camboriú</span><span>📱 (47) 99607-2036</span><span>✉️ comercial@entrelinhas.online</span></div>
  <script>window.onload = () => setTimeout(() => window.print(), 400);<\/script>
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w) {
    showAppAlert('O navegador bloqueou a janela de impressão. Permita pop-ups para este site e tente de novo.', 'Imprimir Relatório');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// Portal da Família: relatórios finalizados
async function renderParentPedagogicalReports() {
  const tab = document.getElementById('parent-tab-report');
  const studentId = state.parentStudent ? state.parentStudent.id : null;
  if (!tab || !studentId) return;
  let box = document.getElementById('parent-ped-reports');
  if (!box) {
    box = document.createElement('div');
    box.id = 'parent-ped-reports';
    box.className = 'parent-ped-reports';
    tab.appendChild(box);
  }
  box.innerHTML = '<div class="text-muted" style="padding:12px 0;">Carregando relatórios de acompanhamento...</div>';
  try {
    const reports = await apiJson(`/api/students/${studentId}/pedagogical-reports`);
    pedState.reports = reports;
    box.innerHTML = `
      <h3 style="margin:22px 0 4px;">📋 Relatórios de Acompanhamento Pedagógico</h3>
      <p class="text-sm text-muted" style="margin:0 0 12px;">Avaliações periódicas escritas pelo(a) professor(a).</p>
      ${reports.length === 0 ? '<div class="ped-empty">Ainda não há relatórios de acompanhamento publicados.</div>' : reports.map(r => `
        <div class="ped-item">
          <div class="ped-item-main">
            <strong>Relatório de ${escapeHtml(r.report_date_br)}</strong>
            <small class="text-muted">${r.period_start_br && r.period_end_br ? `Período ${r.period_start_br} a ${r.period_end_br} · ` : ''}Prof. ${escapeHtml(r.teacher_display_name || '-')}</small>
          </div>
          <div class="ped-item-actions">
            <button type="button" class="btn-card-action primary" onclick="viewPedagogicalReportById(${r.id})">👁️ Visualizar</button>
            <button type="button" class="btn-card-action secondary" onclick="printPedagogicalReportById(${r.id})">🖨️ Imprimir</button>
          </div>
        </div>
      `).join('')}
    `;
  } catch (err) {
    box.innerHTML = `<div class="text-danger">${escapeHtml(err.message)}</div>`;
  }
}

window.openPedagogicalReports = openPedagogicalReports;
window.renderPedForm = renderPedForm;
window.renderPedList = renderPedList;
window.deletePedagogicalReport = deletePedagogicalReport;
window.printPedagogicalReportById = printPedagogicalReportById;
window.viewPedagogicalReportById = viewPedagogicalReportById;
window.renderPedView = renderPedView;

// =========================================================================
// Relatórios de Acompanhamento Pedagógico também na tela "Relatórios"
// (abaixo do relatório dia a dia do aluno selecionado)
// =========================================================================
async function renderReportPedSection(studentId) {
  const sheet = document.getElementById('report-student-sheet');
  if (!sheet || !studentId) return;
  let box = document.getElementById('report-ped-section');
  if (!box) {
    box = document.createElement('div');
    box.id = 'report-ped-section';
    box.className = 'report-ped-section no-print';
    sheet.insertAdjacentElement('afterend', box);
  }
  box.dataset.studentId = studentId;
  box.innerHTML = '<div class="text-muted" style="padding:14px 0;">Carregando relatórios de acompanhamento...</div>';
  try {
    const reports = await apiJson(`/api/students/${studentId}/pedagogical-reports`);
    if (String(box.dataset.studentId) !== String(studentId)) return; // outro aluno foi selecionado no meio
    const u = state.currentUser;
    const canEdit = r => u && (u.role === 'admin' || r.teacher_id === u.id);
    box.innerHTML = `
      <div class="report-ped-head">
        <div>
          <h3>📋 Relatórios de Acompanhamento Pedagógico</h3>
          <p class="text-sm text-muted">Fichas preenchidas pelos professores. As finalizadas ficam visíveis para a família.</p>
        </div>
        <button type="button" class="btn-primary-action" onclick="openPedFromReports(${studentId}, null)"><span>➕ Novo relatório</span></button>
      </div>
      ${reports.length === 0 ? '<div class="ped-empty">Nenhum relatório de acompanhamento para este aluno ainda.</div>' : reports.map(r => `
        <div class="ped-item">
          <div class="ped-item-main">
            <strong>Relatório de ${escapeHtml(r.report_date_br)}</strong>
            <span class="ped-status ${r.status}">${r.status === 'finalizado' ? '✅ Finalizado' : '📝 Rascunho'}</span>
            <small class="text-muted">
              ${r.period_start_br && r.period_end_br ? `Período ${r.period_start_br} a ${r.period_end_br} · ` : ''}
              ${r.lessons_count !== null && r.lessons_count !== undefined ? `${r.lessons_count} aula(s) · ` : ''}
              Prof. ${escapeHtml(r.teacher_display_name || '-')}
            </small>
          </div>
          <div class="ped-item-actions">
            <button type="button" class="btn-card-action primary" onclick="viewPedagogicalReportById(${r.id}, ${studentId})">👁️ Visualizar</button>
            <button type="button" class="btn-card-action secondary" onclick="printPedagogicalReportById(${r.id})">🖨️ Imprimir</button>
            ${canEdit(r) ? `<button type="button" class="btn-card-action secondary" onclick="openPedFromReports(${studentId}, ${r.id})">✏️ Editar</button>` : ''}
          </div>
        </div>
      `).join('')}
    `;
  } catch (err) {
    box.innerHTML = `<div class="text-danger" style="padding:14px 0;">${escapeHtml(err.message)}</div>`;
  }
}

// Abre a Ficha já no formulário (novo ou edição) a partir da tela Relatórios
async function openPedFromReports(studentId, reportId) {
  await openPedagogicalReports(studentId);
  renderPedForm(reportId);
}

function refreshReportPedSectionIfOpen() {
  const box = document.getElementById('report-ped-section');
  if (state.activeView === 'view-reports' && box && box.dataset.studentId) {
    renderReportPedSection(box.dataset.studentId);
  }
}

window.openPedFromReports = openPedFromReports;

// Próxima ocorrência de uma aula da grade (hoje, se ainda não terminou, até 60 dias à frente)
function findNextStudentClass(schedules) {
  const now = new Date();
  const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const weekday = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  for (let i = 0; i <= 60; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const todays = schedules
      .filter(s => isScheduleActiveOnDate(s, day) && (i > 0 || (s.end_time || '') > nowTime))
      .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    if (todays.length > 0) {
      const dateBr = `${String(day.getDate()).padStart(2, '0')}/${String(day.getMonth() + 1).padStart(2, '0')}`;
      const label = i === 0 ? `Hoje (${dateBr})` : i === 1 ? `Amanhã (${dateBr})` : `${weekday[day.getDay()].replace(/^./, c => c.toUpperCase())}, ${dateBr}`;
      return { sched: todays[0], label };
    }
  }
  return null;
}

// =========================================================================
// ✉️ MENSAGENS DA FAMÍLIA (PORTAL DOS PAIS) E RESPOSTAS DA EQUIPE
// =========================================================================
const FAMILY_MSG_STATUS = {
  nova: { label: '✉️ Enviada', cls: 'fm-status-new' },
  lida: { label: '👀 Lida pela escola', cls: 'fm-status-read' },
  respondida: { label: '✅ Respondida', cls: 'fm-status-answered' }
};

function familyMsgCard(item, viewer) {
  const st = FAMILY_MSG_STATUS[item.status] || FAMILY_MSG_STATUS.nova;
  const to = item.recipient_type === 'coordenacao'
    ? 'Coordenação pedagógica'
    : `Prof(a). ${escapeHtml(item.teacher_name || '-')}`;
  const when = item.created_at_br || '';
  const replyBlock = item.reply ? `
    <div class="fm-reply">
      <strong>💬 ${viewer === 'parent' ? 'Resposta da escola' : 'Sua resposta'}${item.reply_by_name && viewer === 'parent' ? ` · ${escapeHtml(item.reply_by_name)}` : ''}${item.replied_at_br ? ` · ${item.replied_at_br}` : ''}</strong>
      <p>${escapeHtml(item.reply)}</p>
    </div>` : '';

  let replyForm = '';
  if (viewer === 'staff' && !item.reply) {
    replyForm = `
      <form class="fm-reply-form" data-fm-reply-form="${item.id}">
        <label class="sr-only" for="fm-reply-${item.id}">Sua resposta para a família</label>
        <textarea id="fm-reply-${item.id}" rows="2" maxlength="2000" required placeholder="Escreva a resposta para a família…"></textarea>
        <button type="submit" class="btn-card-action primary">Responder</button>
      </form>`;
  }

  return `
    <article class="fm-card" data-fm-id="${item.id}">
      <header class="fm-card-head">
        <div>
          <strong class="fm-to">Para: ${to}</strong>
          <small class="text-muted">${viewer === 'staff' ? `De: ${escapeHtml(item.parent_name || 'Família')} · ` : ''}${escapeHtml(when)}</small>
        </div>
        <span class="fm-status ${st.cls}">${st.label}</span>
      </header>
      <p class="fm-body">${escapeHtml(item.body).replace(/\n/g, '<br>')}</p>
      ${replyBlock}
      ${replyForm}
    </article>`;
}

async function loadParentFamilyMessages() {
  const box = document.getElementById('parent-family-messages');
  if (!box) return;
  try {
    const items = await apiJson('/api/parent/messages');
    box.innerHTML = items.length === 0
      ? '<div class="fm-empty">Você ainda não enviou mensagens. Use o botão “Enviar mensagem” para falar com a escola.</div>'
      : items.map(i => familyMsgCard(i, 'parent')).join('');
  } catch (err) {
    box.innerHTML = `<div class="text-danger">${escapeHtml(err.message)}</div>`;
  }
}

async function openFamilyMessageModal() {
  const select = document.getElementById('fm-recipient');
  const form = document.getElementById('form-family-msg');
  form.reset();
  document.getElementById('fm-counter').textContent = '0 / 1000';
  document.getElementById('modal-family-msg').classList.remove('hidden');
  try {
    const r = await apiJson('/api/parent/message-recipients');
    const options = ['<option value="">Escolha o destinatário…</option>'];
    r.professores.forEach(p => options.push(`<option value="professor:${p.id}">Professor(a) ${escapeHtml(p.name)}</option>`));
    options.push(`<option value="coordenacao">${escapeHtml(r.coordenacao.label)}</option>`);
    select.innerHTML = options.join('');
    if (r.professores.length === 1) select.value = `professor:${r.professores[0].id}`;
  } catch (err) {
    select.innerHTML = '<option value="">Não foi possível carregar os destinatários</option>';
    showAppAlert(err.message, 'Enviar mensagem');
  }
}

async function submitFamilyMessage(e) {
  e.preventDefault();
  const select = document.getElementById('fm-recipient');
  const body = document.getElementById('fm-body').value.trim();
  if (!select.value) return showAppAlert('Escolha para quem é a mensagem.', 'Enviar mensagem');
  const isTeacher = select.value.startsWith('professor:');
  const btn = document.getElementById('btn-send-family-msg');
  btn.disabled = true;
  try {
    await apiJson('/api/parent/messages', {
      method: 'POST',
      body: JSON.stringify({
        recipient_type: isTeacher ? 'professor' : 'coordenacao',
        teacher_id: isTeacher ? parseInt(select.value.split(':')[1]) : null,
        body
      })
    });
    closeModalById('modal-family-msg');
    showToast('Mensagem enviada! A equipe responderá por aqui.');
    loadParentFamilyMessages();
  } catch (err) {
    showAppAlert(err.message, 'Enviar mensagem');
  } finally {
    btn.disabled = false;
  }
}

// Equipe: mensagens da família dentro da agenda do aluno
async function loadStaffFamilyMessages(studentId) {
  const section = document.getElementById('agenda-family-section');
  const list = document.getElementById('agenda-family-list');
  const counter = document.getElementById('agenda-family-counter');
  if (!section || !list) return;
  section.hidden = true;
  list.innerHTML = '';
  try {
    const items = await apiJson(`/api/students/${studentId}/family-messages`);
    if (items.length === 0) return;
    section.hidden = false;
    const pending = items.filter(i => i.status === 'nova').length;
    counter.textContent = pending > 0 ? `${pending} sem leitura` : `${items.length} mensagem(ns)`;
    list.innerHTML = items.map(i => familyMsgCard(i, 'staff')).join('');
    // Abrir a agenda com a mensagem na tela já a marca como lida
    items.filter(i => i.status === 'nova').forEach(i => {
      apiJson(`/api/family-messages/${i.id}/read`, { method: 'POST' }).catch(() => {});
    });
  } catch (err) {
    section.hidden = false;
    list.innerHTML = `<div class="text-danger">${escapeHtml(err.message)}</div>`;
  }
}

async function submitFamilyReply(form) {
  const id = form.getAttribute('data-fm-reply-form');
  const reply = form.querySelector('textarea').value.trim();
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    await apiJson(`/api/family-messages/${id}/reply`, { method: 'POST', body: JSON.stringify({ reply }) });
    showToast('Resposta enviada para a família.');
    const studentId = state.currentAgendaStudentId;
    loadStaffFamilyMessages(studentId);
    refreshFamilyAlerts();
  } catch (err) {
    showAppAlert(err.message, 'Responder família');
  } finally {
    btn.disabled = false;
  }
}

function setupFamilyMessaging() {
  const open = document.getElementById('btn-open-family-msg');
  if (open) open.addEventListener('click', openFamilyMessageModal);

  const form = document.getElementById('form-family-msg');
  if (form) form.addEventListener('submit', submitFamilyMessage);

  const body = document.getElementById('fm-body');
  if (body) body.addEventListener('input', () => {
    document.getElementById('fm-counter').textContent = `${body.value.length} / 1000`;
  });

  const staffList = document.getElementById('agenda-family-list');
  if (staffList) staffList.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-fm-reply-form]');
    if (!form) return;
    e.preventDefault();
    submitFamilyReply(form);
  });
}

window.loadParentFamilyMessages = loadParentFamilyMessages;
window.loadStaffFamilyMessages = loadStaffFamilyMessages;

// =========================================================================
// ✉️ AVISOS DE MENSAGENS DA FAMÍLIA NOS PAINÉIS (PROFESSOR E COORDENAÇÃO)
// =========================================================================
function familyAlertCard(items, scope) {
  if (!items || items.length === 0) return '';
  const shown = items.slice(0, 5);
  const more = items.length - shown.length;
  const title = scope === 'coordenacao'
    ? `${items.length} mensagem(ns) da família sem resposta`
    : `${items.length} mensagem(ns) da família aguardando sua resposta`;
  const rows = shown.map(m => {
    const dest = m.recipient_type === 'coordenacao'
      ? 'Coordenação'
      : `Prof. ${escapeHtml(m.teacher_name || '-')}`;
    const preview = m.body.length > 90 ? m.body.slice(0, 90) + '…' : m.body;
    const newBadge = m.status === 'nova' ? '<span class="fm-status fm-status-new">Nova</span>' : '';
    return `
      <li class="family-alert-item">
        <div>
          <strong>${escapeHtml(m.student_name)}</strong>
          <small class="text-muted">${dest} · ${escapeHtml(m.created_at_br || '')} ${newBadge}</small>
          <span class="family-alert-preview">“${escapeHtml(preview)}”</span>
        </div>
        <button type="button" class="btn-card-action primary" data-fm-open="${m.student_id}">Responder</button>
      </li>`;
  }).join('');
  return `
    <div class="pendency-card danger family-alert" role="region" aria-label="Mensagens da família">
      <div class="pendency-info">
        <span class="pendency-icon" aria-hidden="true">✉️</span>
        <div class="pendency-text" style="min-width:0; flex:1;">
          <strong>${title}</strong>
          <ul class="family-alert-list">${rows}</ul>
          ${more > 0 ? `<small class="text-muted">+ ${more} outra(s) — abra a agenda do aluno para ver todas.</small>` : ''}
        </div>
      </div>
    </div>`;
}

// Professor: aviso no topo da tela "Hoje"
async function loadTeacherFamilyAlerts() {
  const box = document.getElementById('teacher-family-alerts');
  if (!box) return;
  try {
    const items = await apiJson('/api/family-messages/pending');
    box.innerHTML = familyAlertCard(items, 'professor');
    box.hidden = items.length === 0;
  } catch (err) {
    box.hidden = true;
  }
}

// Coordenação: aviso no painel de pendências
async function appendAdminFamilyAlerts() {
  const grid = document.getElementById('admin-pendency-grid');
  if (!grid) return;
  try {
    const items = await apiJson('/api/family-messages/pending');
    const html = familyAlertCard(items, 'coordenacao');
    if (html) {
      // Com pendência, o cartão "Tudo em dia" não faz sentido
      grid.querySelectorAll('.success-none').forEach(el => el.remove());
      grid.insertAdjacentHTML('afterbegin', html);
    }
  } catch (err) {
    /* o painel continua funcionando sem o aviso */
  }
}

function setupFamilyAlerts() {
  // Botão "Responder" dos avisos: abre a agenda do aluno, onde está a mensagem
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fm-open]');
    if (!btn) return;
    openStudentAgendaModal(btn.getAttribute('data-fm-open'));
  });
}

function refreshFamilyAlerts() {
  loadTeacherFamilyAlerts();
  const grid = document.getElementById('admin-pendency-grid');
  if (grid && state.activeView === 'view-admin-dashboard') loadAdminDashboard();
}
