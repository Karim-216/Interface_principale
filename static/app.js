/* ============================================================
   DIRIVA — Interface de saisie manuelle de CV (frontend)
   Parle au backend Flask via l'API REST /api/... — aucune logique
   métier ici, seulement l'affichage et les appels réseau.
   ============================================================ */

const APP_LABEL = 'Diriva';
const DATA_SOURCE_TYPES = window.DATA_SOURCE_TYPES || [];

// Champs de la section Identité qui ont chacun leur propre repère de source
// (voir srcMini / fieldSourceSet) — réutilisé par le bouton "source par
// défaut pour cette section". Jour/mois/année de naissance partagent un
// seul et même repère ('birthDate'), plutôt que trois séparés.
const IDENTITY_SOURCE_FIELDS = [
  'commonName','usualFirstname','otherFirstname','marriedName','birthName','genre',
  'birthDate','birthPlace','birthCountry','profession','hobby','remarks',
];

// Onglets du formulaire, dans l'ordre d'affichage. Sources en premier : les
// autres sections y font référence (on y choisit le fichier source plutôt
// que de retaper un nom de source). Institutions avant Parcours/Formation,
// pour la même raison (on les y choisit dans une liste déroulante).
const FORM_TABS = [
  { key:'sources',       label:'Sources du CV' },
  { key:'identity',      label:'Identité' },
  { key:'institutions',  label:'Institutions' },
  { key:'trajectories',  label:'Parcours professionnel' },
  { key:'educations',    label:'Formation' },
  { key:'distinctions',  label:'Distinctions' },
  { key:'relatives',     label:'Parenté' },
];

const state = {
  screen: 'login',       // login | dashboard | institutions | institutionForm | sources | form | history
  user: '',
  list: [],
  search: '',
  referentials: null,
  editingPK: null,
  form: null,
  formTab: 'sources',
  duplicates: [],
  statusMsg: null,
  confirmDeletePK: null,
  historyEntries: [],
  historyFilterPK: null,
  loading: false,
  autoSaveStatus: '',    // texte affiché près du bouton Enregistrer

  // Page Institutions (recherche globale, accessible depuis la barre de nav)
  institutionsList: [],
  institutionsSearch: '',
  editingInstitutionPK: null,
  institutionForm: null,
  institutionStatusMsg: null,

  // Onglet Institutions DANS le formulaire d'une fiche (gérer/créer les
  // institutions sans quitter la saisie en cours)
  formInstSearch: '',
  formInstList: [],
  formInstEditPK: null,     // null = rien en édition | 'new' | un INS_PK
  formInstEditData: null,
  formInstStatusMsg: null,

  // Page Sources
  sourcesList: [],
  sourcesSearch: '',
};

/* ---------- Appels API ---------- */

async function api(path, opts){
  opts = opts || {};
  const headers = Object.assign({'Content-Type':'application/json'}, opts.headers || {});
  const res = await fetch('/api/' + path, Object.assign({}, opts, {headers}));
  if(!res.ok){
    let msg = 'Erreur serveur (' + res.status + ')';
    let payload = null;
    try{ payload = await res.json(); if(payload && payload.error) msg = payload.error; }catch(e){}
    const err = new Error(msg);
    err.payload = payload;
    throw err;
  }
  if(res.status === 204) return null;
  return res.json();
}

/* ---------- Outils ---------- */

function esc(s){
  if(s===null||s===undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function showToast(text){
  const t = document.createElement('div');
  t.className='toast'; t.textContent=text;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2600);
}

/* ============================================================
   ROUTEUR
   ============================================================ */

const NAV_PAGES = [
  { key:'dashboard',    label:'Individus' },
  { key:'institutions', label:'Institutions' },
  { key:'sources',      label:'Sources' },
];

function render(){
  const app = document.getElementById('app');
  if(state.screen==='login') app.innerHTML = viewLogin();
  else if(state.screen==='dashboard') app.innerHTML = viewTopbar() + viewNavBar() + viewDashboard();
  else if(state.screen==='institutions') app.innerHTML = viewTopbar() + viewNavBar() + viewInstitutions();
  else if(state.screen==='institutionForm') app.innerHTML = viewTopbar() + viewInstitutionForm();
  else if(state.screen==='sources') app.innerHTML = viewTopbar() + viewNavBar() + viewSourcesPage();
  else if(state.screen==='form') app.innerHTML = viewTopbar() + viewForm();
  else if(state.screen==='history') app.innerHTML = viewTopbar() + viewHistory();
}

function viewTopbar(){
  return `
  <div class="topbar">
    <div class="brand"><h1>${esc(APP_LABEL)}</h1><span>Registre des CV</span></div>
    <div class="topbar-actions">
      <span>${esc(state.user)}</span>
      <button class="ghost" onclick="logout()">Se déconnecter</button>
    </div>
  </div>`;
}

function viewNavBar(){
  return `
  <div class="nav-bar">
    ${NAV_PAGES.map(p => `<button class="nav-btn ${state.screen===p.key?'active':''}" onclick="goToPage('${p.key}')">${esc(p.label)}</button>`).join('')}
  </div>`;
}

async function goToPage(key){
  state.screen = key;
  render();
  if(key === 'dashboard') await loadDashboard();
  else if(key === 'institutions') await loadInstitutions();
  else if(key === 'sources') await loadSourcesPage();
}

/* ---------- Écran 1 : connexion ---------- */

function viewLogin(){
  const remembered = localStorage.getItem('diriva_user') || '';
  return `
  <div class="center-screen">
    <div class="panel login-box">
      <h1>Diriva</h1>
      <p>Saisie manuelle des CV. Entrez votre nom pour continuer.</p>
      <div class="field">
        <label for="login-name">Votre nom</label>
        <input type="text" id="login-name" value="${esc(remembered)}" placeholder="ex. Camille Dubois" onkeydown="if(event.key==='Enter')doLogin()">
      </div>
      <button class="primary" onclick="doLogin()" style="width:100%">Se connecter</button>
    </div>
  </div>`;
}

function doLogin(){
  const val = document.getElementById('login-name').value.trim();
  if(!val) return;
  state.user = val;
  localStorage.setItem('diriva_user', val);
  state.screen = 'dashboard';
  render();
  loadDashboard();
}

function logout(){
  state.user=''; state.list=[]; state.screen='login';
  render();
}

/* ---------- Écran 2 : tableau de bord ---------- */

async function loadDashboard(){
  try{
    state.list = await api('individuals');
  }catch(e){
    showToast("Impossible de charger la liste : " + e.message);
    state.list = [];
  }
  renderDashboardList();
}

function viewDashboard(){
  return `
  <div class="dash-head">
    <h2 id="dash-count">…</h2>
    <div class="dash-toolbar">
      <button onclick="openHistory(null)">Journal d'activité</button>
      <button class="primary" onclick="openNewForm()">+ Nouveau CV</button>
    </div>
  </div>
  <div class="search-row">
    <input type="text" placeholder="Rechercher par nom ou prénom…" value="${esc(state.search)}" oninput="state.search=this.value; renderDashboardList();">
  </div>
  <div id="dash-list">Chargement…</div>
  `;
}

function normalizeClient(str){
  return (str||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[-']/g,' ').replace(/\s+/g,' ').trim().toLowerCase();
}

function renderDashboardList(){
  const q = normalizeClient(state.search);
  let list = state.list.filter(ind => {
    if(!q) return true;
    const full = normalizeClient((ind.birthName||'')+' '+(ind.usualFirstname||''));
    return full.includes(q);
  });

  const countEl = document.getElementById('dash-count');
  if(countEl) countEl.textContent = `${list.length} fiche${list.length>1?'s':''}`;

  const el = document.getElementById('dash-list');
  if(!el) return;
  if(list.length===0){
    el.innerHTML = `<div class="empty-state panel">Aucune fiche pour l'instant. Cliquez sur « + Nouveau CV » pour commencer.</div>`;
    return;
  }
  el.innerHTML = list.map(ind => {
    const isConfirming = state.confirmDeletePK === ind.pk;
    const lastAction = ind.updatedAt
      ? `modifié par ${esc(ind.updatedBy)} le ${esc(ind.updatedAt.slice(0,10))}`
      : `ajouté par ${esc(ind.addedBy)} le ${esc((ind.addedAt||'').slice(0,10))}`;
    return `
    <div class="ind-row">
      <div class="ind-main">
        <span class="pk-badge mono">IND·${String(ind.pk).padStart(3,'0')}</span>
        <div>
          <div class="ind-name">${esc(ind.usualFirstname||'')} ${esc(ind.commonName||ind.birthName||'')}</div>
          <div class="ind-meta">${ind.profession ? esc(ind.profession)+' · ' : ''}${lastAction}</div>
        </div>
      </div>
      <div class="ind-actions">
        ${isConfirming ? `
          <span class="confirm-inline">
            <span class="hint" style="margin:0">Supprimer définitivement ?</span>
            <button class="small danger-outline" onclick="deleteIndividual(${ind.pk})">Confirmer</button>
            <button class="small ghost" onclick="state.confirmDeletePK=null; renderDashboardList();">Annuler</button>
          </span>
        ` : `
          <button class="small" onclick="openEditForm(${ind.pk})">Modifier</button>
          <button class="small ghost" onclick="openHistory(${ind.pk})">Historique</button>
          <button class="small danger-outline" onclick="state.confirmDeletePK=${ind.pk}; renderDashboardList();">Supprimer</button>
        `}
      </div>
    </div>`;
  }).join('');
}

async function deleteIndividual(pk){
  try{
    await api('individual/' + pk, {
      method:'DELETE', body: JSON.stringify({user: state.user}),
    });
    state.confirmDeletePK = null;
    showToast('Fiche supprimée.');
    await loadDashboard();
  }catch(e){
    showToast("Erreur : " + e.message);
  }
}

/* ============================================================
   JOURNAL D'HISTORIQUE
   ============================================================ */

async function openHistory(pk){
  state.historyFilterPK = pk;
  state.screen = 'history';
  render();
  try{
    const qs = pk ? ('?ind_pk=' + pk) : '';
    state.historyEntries = await api('history' + qs);
  }catch(e){
    state.historyEntries = [];
    showToast("Impossible de charger le journal : " + e.message);
  }
  renderHistoryList();
}

function viewHistory(){
  return `
  <div class="dash-head">
    <h2>${state.historyFilterPK ? 'Historique de la fiche IND·'+String(state.historyFilterPK).padStart(3,'0') : "Journal d'activité"}</h2>
    <button class="ghost" onclick="backToDashboard()">← Retour à la liste</button>
  </div>
  <div id="hist-list">Chargement…</div>
  `;
}

const HIST_TYPE_LABEL = {'création':'Création','modification':'Modification','suppression':'Suppression'};
const HIST_TYPE_CLASS = {'création':'hist-type-creation','modification':'hist-type-modification','suppression':'hist-type-suppression'};

function renderHistoryList(){
  const el = document.getElementById('hist-list');
  if(!el) return;
  if(state.historyEntries.length===0){
    el.innerHTML = `<div class="empty-state panel">Aucune entrée dans le journal pour l'instant.</div>`;
    return;
  }
  el.innerHTML = state.historyEntries.map(h => {
    const badge = `<span class="hist-type ${HIST_TYPE_CLASS[h.changeType]||''}">${esc(HIST_TYPE_LABEL[h.changeType]||h.changeType)}</span>`;
    const name = state.historyFilterPK ? '' :
      `<span class="hist-name-link" onclick="openHistory(${h.indPK})">${esc(h.individualName)} (IND·${String(h.indPK).padStart(3,'0')})</span> — `;
    const details = (h.details && h.details.length) ? `
      <div class="hist-details"><ul>
        ${h.details.map(d => d.type==='field'
          ? `<li><strong>${esc(d.label)}</strong> : « ${esc(d.old)} » → « ${esc(d.new)} »</li>`
          : `<li>${esc(d.type==='ajout'?'Ajout':d.type==='suppression'?'Retrait':'Modification')} — ${esc(d.label)} : ${esc(d.value)}</li>`
        ).join('')}
      </ul></div>` : '';
    return `
    <div class="hist-entry">
      <div class="hist-head">
        <div>${badge}${name}<span class="hist-who">${esc(h.changedBy)}</span></div>
        <span class="hist-when">${esc((h.changedAt||'').replace('T',' ').replace('Z',''))}</span>
      </div>
      <div class="hist-summary">${esc(h.summary)}</div>
      ${details}
    </div>`;
  }).join('');
}

/* ============================================================
   PAGE INSTITUTIONS
   ============================================================ */

async function loadInstitutions(){
  try{
    const qs = state.institutionsSearch ? ('?q=' + encodeURIComponent(state.institutionsSearch)) : '';
    state.institutionsList = await api('institutions' + qs);
  }catch(e){
    state.institutionsList = [];
    showToast("Impossible de charger les institutions : " + e.message);
  }
  renderInstitutionsListInPlace();
}

function viewInstitutions(){
  return `
  <div class="dash-head">
    <h2 id="inst-count">…</h2>
    <button class="primary" onclick="openNewInstitutionForm()">+ Nouvelle institution</button>
  </div>
  <div class="search-row">
    <input type="text" placeholder="Rechercher une institution…" value="${esc(state.institutionsSearch)}"
      oninput="state.institutionsSearch=this.value; loadInstitutionsDebounced();">
  </div>
  <div id="inst-list">Chargement…</div>
  `;
}

let institutionsSearchTimer = null;
function loadInstitutionsDebounced(){
  clearTimeout(institutionsSearchTimer);
  institutionsSearchTimer = setTimeout(loadInstitutions, 250);
}

function renderInstitutionsListInPlace(){
  const countEl = document.getElementById('inst-count');
  if(countEl) countEl.textContent = `${state.institutionsList.length} institution${state.institutionsList.length>1?'s':''}`;
  const el = document.getElementById('inst-list');
  if(!el) return;
  if(state.institutionsList.length===0){
    el.innerHTML = `<div class="empty-state panel">Aucune institution trouvée.</div>`;
    return;
  }
  el.innerHTML = state.institutionsList.map(i => `
    <div class="ind-row">
      <div class="ind-main">
        <div>
          <div class="ind-name">${esc(i.name)}</div>
          <div class="ind-meta">${esc(i.typeName||'')}${i.city ? ' — ' + esc(i.city) : ''}${i.country ? ' (' + esc(i.country) + ')' : ''}</div>
        </div>
      </div>
      <div class="ind-actions">
        <button class="small" onclick="openEditInstitutionForm(${i.pk})">Modifier</button>
      </div>
    </div>
  `).join('');
}

function blankInstitutionForm(){
  return { pk:null, name:'', type:'Entreprise', city:'', country:'', street:'', streetNumber:'', remarks:'' };
}

function openNewInstitutionForm(){
  state.editingInstitutionPK = null;
  state.institutionForm = blankInstitutionForm();
  state.institutionStatusMsg = null;
  state.screen = 'institutionForm';
  render();
  ensureReferentials().then(rerenderInstitutionForm);
}

async function openEditInstitutionForm(pk){
  state.editingInstitutionPK = pk;
  state.institutionStatusMsg = null;
  state.screen = 'institutionForm';
  render();
  try{
    const [f] = await Promise.all([ api('institution/' + pk), ensureReferentials() ]);
    state.institutionForm = f;
  }catch(e){
    showToast("Impossible de charger l'institution : " + e.message);
    state.screen = 'institutions';
    render();
    return;
  }
  render();
}

function rerenderInstitutionForm(){
  if(state.screen === 'institutionForm') document.getElementById('app').innerHTML = viewTopbar() + viewInstitutionForm();
}

function viewInstitutionForm(){
  const f = state.institutionForm;
  if(!f) return `<div class="panel">Chargement…</div>`;
  const isEdit = state.editingInstitutionPK !== null;
  return `
  <div class="dash-head">
    <h2>${isEdit ? "Modifier l'institution" : 'Nouvelle institution'}</h2>
    <button class="ghost" onclick="backToInstitutions()">← Retour à la liste</button>
  </div>
  ${state.institutionStatusMsg ? `<div class="status-msg status-error">${esc(state.institutionStatusMsg)}</div>` : ''}
  <div class="panel section">
    <div class="grid grid-2">
      <div class="field"><label>Nom *</label><input type="text" required value="${esc(f.name)}" oninput="instFormSet('name',this.value)"></div>
      <div class="field"><label>Type</label><input type="text" list="dl-institutiontypes" value="${esc(f.type)}" oninput="instFormSet('type',this.value)"></div>
    </div>
    <div class="grid grid-2" style="margin-top:14px">
      <div class="field"><label>Ville</label><input type="text" list="dl-municipalities" value="${esc(f.city)}" oninput="instFormSet('city',this.value)"></div>
      <div class="field"><label>Pays</label><input type="text" list="dl-birthcountries" value="${esc(f.country)}" oninput="instFormSet('country',this.value)"></div>
    </div>
    <div class="grid grid-2" style="margin-top:14px">
      <div class="field"><label>Rue</label><input type="text" value="${esc(f.street)}" oninput="instFormSet('street',this.value)"></div>
      <div class="field"><label>Numéro</label><input type="text" value="${esc(f.streetNumber)}" oninput="instFormSet('streetNumber',this.value)"></div>
    </div>
    <div class="field" style="margin-top:14px"><label>Remarques</label><textarea oninput="instFormSet('remarks',this.value)">${esc(f.remarks)}</textarea></div>
  </div>
  <div class="form-footer">
    <span></span>
    <div>
      <button class="ghost" onclick="backToInstitutions()">Annuler</button>
      <button class="primary" onclick="saveInstitutionForm()">Enregistrer</button>
    </div>
  </div>
  ${datalists()}
  `;
}

function instFormSet(field, value){ state.institutionForm[field] = value; }

function backToInstitutions(){
  state.screen = 'institutions';
  render();
  loadInstitutions();
}

async function saveInstitutionForm(){
  const f = state.institutionForm;
  if(!(f.name||'').trim()){
    state.institutionStatusMsg = "Le nom de l'institution est obligatoire.";
    render();
    return;
  }
  try{
    await api('institution', {
      method:'POST',
      body: JSON.stringify({ user: state.user, pk: state.editingInstitutionPK, ...f }),
    });
    showToast('Institution enregistrée.');
    backToInstitutions();
  }catch(e){
    state.institutionStatusMsg = e.message;
    render();
  }
}

/* ============================================================
   ONGLET « Institutions » DANS le formulaire d'une fiche — gérer/créer les
   institutions sans quitter la saisie en cours (distinct de la page globale
   ci-dessus, qui reste accessible pour rechercher à travers toute la base).
   ============================================================ */

async function loadFormInstitutions(){
  try{
    const qs = state.formInstSearch ? ('?q=' + encodeURIComponent(state.formInstSearch)) : '';
    state.formInstList = await api('institutions' + qs);
  }catch(e){
    state.formInstList = [];
    showToast("Impossible de charger les institutions : " + e.message);
  }
  renderInstitutionsTabInPlace();
}

let formInstSearchTimer = null;
function loadFormInstitutionsDebounced(){
  clearTimeout(formInstSearchTimer);
  formInstSearchTimer = setTimeout(loadFormInstitutions, 250);
}

function renderInstitutionsTabInPlace(){
  const el = document.getElementById('form-inst-tab');
  if(el) el.innerHTML = renderInstitutionsTab();
}

function renderInstitutionsTab(){
  const editing = state.formInstEditPK !== null;
  return `
    <div class="search-row">
      <input type="text" placeholder="Rechercher une institution…" value="${esc(state.formInstSearch)}"
        oninput="state.formInstSearch=this.value; loadFormInstitutionsDebounced();">
      <button onclick="openFormInstNew()">+ Nouvelle</button>
    </div>
    ${editing ? renderFormInstEditor() : ''}
    <div>
      ${state.formInstList.length===0 ? `<p class="hint">Aucune institution trouvée.</p>` : state.formInstList.map(i => `
        <div class="ind-row">
          <div class="ind-main">
            <div>
              <div class="ind-name">${esc(i.name)}</div>
              <div class="ind-meta">${esc(i.typeName||'')}${i.city ? ' — ' + esc(i.city) : ''}${i.country ? ' (' + esc(i.country) + ')' : ''}</div>
            </div>
          </div>
          <div class="ind-actions"><button class="small" onclick="openFormInstEdit(${i.pk})">Modifier</button></div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderFormInstEditor(){
  const f = state.formInstEditData;
  if(!f) return '';
  return `
  <div class="repeat-item">
    <div class="repeat-item-head">
      <span>${state.formInstEditPK==='new' ? 'Nouvelle institution' : "Modifier l'institution"}</span>
      <button class="small ghost" onclick="cancelFormInstEdit()">Fermer</button>
    </div>
    ${state.formInstStatusMsg ? `<div class="status-msg status-error">${esc(state.formInstStatusMsg)}</div>` : ''}
    <div class="grid grid-2">
      <div class="field"><label>Nom *</label><input type="text" required value="${esc(f.name)}" oninput="formInstSet('name',this.value)"></div>
      <div class="field"><label>Type</label><input type="text" list="dl-institutiontypes" value="${esc(f.type)}" oninput="formInstSet('type',this.value)"></div>
    </div>
    <div class="grid grid-2" style="margin-top:10px">
      <div class="field"><label>Ville</label><input type="text" list="dl-municipalities" value="${esc(f.city)}" oninput="formInstSet('city',this.value)"></div>
      <div class="field"><label>Pays</label><input type="text" list="dl-birthcountries" value="${esc(f.country)}" oninput="formInstSet('country',this.value)"></div>
    </div>
    <div class="grid grid-2" style="margin-top:10px">
      <div class="field"><label>Rue</label><input type="text" value="${esc(f.street)}" oninput="formInstSet('street',this.value)"></div>
      <div class="field"><label>Numéro</label><input type="text" value="${esc(f.streetNumber)}" oninput="formInstSet('streetNumber',this.value)"></div>
    </div>
    <div class="field" style="margin-top:10px"><label>Remarques</label><textarea oninput="formInstSet('remarks',this.value)">${esc(f.remarks)}</textarea></div>
    <div style="margin-top:10px"><button class="primary small" onclick="saveFormInstitution()">Enregistrer l'institution</button></div>
  </div>`;
}

function openFormInstNew(){
  state.formInstEditPK = 'new';
  state.formInstEditData = blankInstitutionForm();
  state.formInstStatusMsg = null;
  renderInstitutionsTabInPlace();
}

async function openFormInstEdit(pk){
  state.formInstEditPK = pk;
  state.formInstStatusMsg = null;
  renderInstitutionsTabInPlace();
  try{
    state.formInstEditData = await api('institution/' + pk);
  }catch(e){
    showToast("Impossible de charger l'institution : " + e.message);
    state.formInstEditPK = null;
  }
  renderInstitutionsTabInPlace();
}

function cancelFormInstEdit(){
  state.formInstEditPK = null;
  state.formInstEditData = null;
  state.formInstStatusMsg = null;
  renderInstitutionsTabInPlace();
}

function formInstSet(field, value){ state.formInstEditData[field] = value; }

async function saveFormInstitution(){
  const f = state.formInstEditData;
  if(!(f.name||'').trim()){
    state.formInstStatusMsg = "Le nom de l'institution est obligatoire.";
    renderInstitutionsTabInPlace();
    return;
  }
  try{
    await api('institution', {
      method:'POST',
      body: JSON.stringify({ user: state.user, pk: state.formInstEditPK==='new' ? null : state.formInstEditPK, ...f }),
    });
    showToast('Institution enregistrée.');
    cancelFormInstEdit();
    await loadFormInstitutions();
    refreshInstitutionsDatalist();
  }catch(e){
    state.formInstStatusMsg = e.message;
    renderInstitutionsTabInPlace();
  }
}

// Les champs Institution (Parcours, Formation) doivent refléter tout de
// suite une institution créée/modifiée depuis cet onglet, sans attendre un
// changement d'onglet qui régénérerait tout le formulaire.
async function refreshInstitutionsDatalist(){
  const el = document.getElementById('dl-institutions');
  if(!el) return;
  try{
    const names = await api('institutions');
    el.innerHTML = names.map(i => `<option value="${esc(i.name)}">`).join('');
  }catch(e){ /* tant pis, la liste se mettra à jour au prochain changement d'onglet */ }
}

/* ============================================================
   PAGE SOURCES
   ============================================================ */

async function loadSourcesPage(){
  try{
    const qs = state.sourcesSearch ? ('?q=' + encodeURIComponent(state.sourcesSearch)) : '';
    state.sourcesList = await api('sources' + qs);
  }catch(e){
    state.sourcesList = [];
    showToast("Impossible de charger les sources : " + e.message);
  }
  renderSourcesPageListInPlace();
}

function viewSourcesPage(){
  return `
  <div class="dash-head">
    <h2 id="src-count">…</h2>
  </div>
  <div class="search-row">
    <input type="text" placeholder="Rechercher un fichier ou un nom de source…" value="${esc(state.sourcesSearch)}"
      oninput="state.sourcesSearch=this.value; loadSourcesPageDebounced();">
  </div>
  <div id="src-page-list">Chargement…</div>
  `;
}

let sourcesSearchTimer = null;
function loadSourcesPageDebounced(){
  clearTimeout(sourcesSearchTimer);
  sourcesSearchTimer = setTimeout(loadSourcesPage, 250);
}

function renderSourcesPageListInPlace(){
  const countEl = document.getElementById('src-count');
  if(countEl) countEl.textContent = `${state.sourcesList.length} source${state.sourcesList.length>1?'s':''}`;
  const el = document.getElementById('src-page-list');
  if(!el) return;
  if(state.sourcesList.length===0){
    el.innerHTML = `<div class="empty-state panel">Aucune source trouvée.</div>`;
    return;
  }
  el.innerHTML = state.sourcesList.map(s => `
    <div class="ind-row">
      <div class="ind-main">
        <div>
          <div class="ind-name mono">${esc(s.filename)}</div>
          <div class="ind-meta">${esc(s.name||'')} — fiche de <span class="hist-name-link" onclick="openIndividualFromSource(${s.individualPK})">${esc(s.individualFirstname)} ${esc(s.individualBirthName)}</span></div>
        </div>
      </div>
    </div>
  `).join('');
}

async function openIndividualFromSource(pk){
  await openEditForm(pk);
  state.formTab = 'sources';
  rerenderForm();
}

/* ============================================================
   FORMULAIRE — nouvelle fiche / édition
   ============================================================ */

function blankForm(){
  return {
    birthName:'', usualFirstname:'', otherFirstname:'', marriedName:'', commonName:'',
    genre:'', birthDay:'', birthMonth:'', birthYear:'', birthPlace:'', birthCountry:'',
    profession:'', hobby:'', remarks:'', fieldSources:{},
    nationalities: [],
    sources: [ blankSource() ],
    trajectories: [ blankTrajectory() ],
    educations: [],
    distinctions: [],
    relatives: [],
  };
}
function blankSource(){ return { filename:'', name:'', remarks:'' }; }
function blankTrajectory(){
  return { position:'', institution:'',
           arena:'Fonction Exécutive', positionDetails:'', remarks:'', workPlace:'',
           principal:true, events:[ blankEvent() ] };
}
function blankEvent(){
  return { day:'', month:'', year:'', nature:'1', event:'', dataSource:'' };
}
function blankEducation(){
  return { school:'', diploma:'', discipline:'', grade:'', startYear:'', endYear:'', initial:true, remarks:'', dataSource:'' };
}
function blankDistinction(){ return { year:'', description:'', remarks:'', dataSource:'' }; }
function blankRelative(){ return { pk:null, firstname:'', lastname:'', relationType:'', profession:'', dataSource:'' }; }
function blankNationality(){ return { country:'', obtentionYear:'', lossYear:'', dataSource:'' }; }

async function ensureReferentials(){
  try{
    state.referentials = await api('referentials');
  }catch(e){
    state.referentials = { positions:[], institutions:[], arenas:[], professions:[], municipalities:[],
                            countries:[], birthCountries:[], diplomas:[], disciplines:[], grades:[], relativeTypes:[],
                            dataSources: DATA_SOURCE_TYPES };
    showToast("Impossible de charger les référentiels : " + e.message);
  }
}

async function openNewForm(){
  state.editingPK = null;
  state.form = blankForm();
  state.formTab = 'sources';
  state.duplicates = [];
  state.statusMsg = null;
  state.autoSaveStatus = '';
  nationalityModalOpen = false;
  state.formInstSearch = ''; state.formInstList = [];
  state.formInstEditPK = null; state.formInstEditData = null; state.formInstStatusMsg = null;
  state.screen = 'form';
  render();
  await ensureReferentials();
  rerenderForm();
}

async function openEditForm(pk){
  state.editingPK = pk;
  state.formTab = 'sources';
  state.duplicates = [];
  state.statusMsg = null;
  state.autoSaveStatus = '';
  nationalityModalOpen = false;
  state.formInstSearch = ''; state.formInstList = [];
  state.formInstEditPK = null; state.formInstEditData = null; state.formInstStatusMsg = null;
  state.screen = 'form';
  render();
  try{
    const [bundle] = await Promise.all([ api('individual/' + pk), ensureReferentials() ]);
    state.form = bundle;
    if(!state.form.sources || state.form.sources.length===0) state.form.sources = [ blankSource() ];
    if(!state.form.fieldSources) state.form.fieldSources = {};
    if(!state.form.nationalities) state.form.nationalities = [];
  }catch(e){
    showToast("Impossible de charger la fiche : " + e.message);
    backToDashboard();
    return;
  }
  rerenderForm();
}

function backToDashboard(){
  flushAutoSave();
  state.screen='dashboard'; state.form=null; state.editingPK=null;
  render();
  loadDashboard();
}

function rerenderForm(){
  if(state.screen==='form'){ document.getElementById('app').innerHTML = viewTopbar() + viewForm(); }
}

/* ---------- Vue formulaire ---------- */

function viewForm(){
  if(!state.form){
    return `<div class="panel">Chargement du formulaire…</div>`;
  }
  const f = state.form;
  const isEdit = state.editingPK !== null;

  return `
  <div class="dash-head">
    <h2>${isEdit ? 'Modifier la fiche' : 'Nouveau CV'}</h2>
    <button class="ghost" onclick="backToDashboard()">← Retour à la liste</button>
  </div>

  ${state.statusMsg ? `<div class="status-msg ${state.statusMsg.type==='error'?'status-error':'status-ok'}">${esc(state.statusMsg.text)}</div>` : ''}
  <div id="dup-warning">${renderDuplicateWarningHtml()}</div>

  ${datalists()}

  <div class="tab-bar">
    ${FORM_TABS.map(t => `<button class="tab-btn ${state.formTab===t.key?'active':''}" onclick="switchFormTab('${t.key}')">${esc(t.label)}</button>`).join('')}
  </div>

  <div class="tab-panel" ${state.formTab!=='sources' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title"><span class="section-num">1</span><h3>Sources du CV</h3></div>
    <p class="section-sub">Un ou plusieurs documents source (LinkedIn, Who's Who, LesBiographies…) ayant servi à cette fiche. Renseignez-les d'abord : les autres sections y feront référence par leur nom de fichier.</p>
    <div id="sources-list">${renderSourcesList()}</div>
    <button class="add-row-btn" onclick="addSource()">+ Ajouter une source</button>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='identity' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">2</span><h3>Identité</h3>
      ${sectionDefaultSourceControl('identity')}
    </div>
    <p class="section-sub">Chaque champ a son propre repère de fichier source (ex. le nom d'usage vient de linkedin.pdf, le nom de naissance de lesbios.pdf) — à choisir dans la liste des fichiers déjà ajoutés dans l'onglet Sources du CV, quand deux fichiers ne disent pas la même chose.</p>
    <div class="grid grid-2">
      <div class="field">
        <div class="field-head"><label>Nom d'usage affiché *</label>${srcMini(f,'commonName')}</div>
        <input type="text" required value="${esc(f.commonName)}" onblur="checkDuplicates()" oninput="form_.commonName=this.value">
      </div>
      <div class="field">
        <div class="field-head"><label>Prénom usuel *</label>${srcMini(f,'usualFirstname')}</div>
        <input type="text" required value="${esc(f.usualFirstname)}" onblur="checkDuplicates()" oninput="form_.usualFirstname=this.value">
      </div>
      <div class="field">
        <div class="field-head"><label>Autres prénoms</label>${srcMini(f,'otherFirstname')}</div>
        <input type="text" value="${esc(f.otherFirstname)}" oninput="form_.otherFirstname=this.value">
      </div>
      <div class="field">
        <div class="field-head"><label>Nom d'usage marital</label>${srcMini(f,'marriedName')}</div>
        <input type="text" value="${esc(f.marriedName)}" oninput="form_.marriedName=this.value">
      </div>
      <div class="field">
        <div class="field-head"><label>Nom de naissance</label>${srcMini(f,'birthName')}</div>
        <input type="text" value="${esc(f.birthName)}" oninput="form_.birthName=this.value">
      </div>
      <div class="field">
        <div class="field-head"><label>Genre *</label>${srcMini(f,'genre')}</div>
        <select onchange="form_.genre=this.value">
          <option value="">—</option>
          <option value="M" ${f.genre==='M'?'selected':''}>M</option>
          <option value="Mme" ${f.genre==='Mme'?'selected':''}>Mme</option>
          <option value="Autre" ${f.genre==='Autre'?'selected':''}>Autre</option>
        </select>
      </div>
    </div>
    <div style="margin-top:14px">
      <button class="small" onclick="openNationalityModal()">🌍 Nationalité(s)${nationalitySummary()}</button>
    </div>
    <div class="field-head" style="margin-top:14px"><label>Date de naissance</label>${srcMini(f,'birthDate')}</div>
    <div class="grid grid-3">
      <div class="field"><label>Jour</label><input type="number" min="1" max="31" value="${esc(f.birthDay)}" oninput="form_.birthDay=this.value"></div>
      <div class="field"><label>Mois</label><input type="number" min="1" max="12" value="${esc(f.birthMonth)}" oninput="form_.birthMonth=this.value"></div>
      <div class="field"><label>Année</label><input type="number" value="${esc(f.birthYear)}" oninput="form_.birthYear=this.value"></div>
    </div>
    <div class="grid grid-2" style="margin-top:14px">
      <div class="field"><div class="field-head"><label>Lieu de naissance</label>${srcMini(f,'birthPlace')}</div><input type="text" list="dl-municipalities" value="${esc(f.birthPlace)}" oninput="form_.birthPlace=this.value"></div>
      <div class="field"><div class="field-head"><label>Pays de naissance</label>${srcMini(f,'birthCountry')}</div><input type="text" list="dl-birthcountries" value="${esc(f.birthCountry)}" oninput="form_.birthCountry=this.value"></div>
    </div>
    <div class="grid grid-2" style="margin-top:14px">
      <div class="field"><div class="field-head"><label>Profession actuelle</label>${srcMini(f,'profession')}</div><input type="text" list="dl-professions" value="${esc(f.profession)}" oninput="form_.profession=this.value"></div>
      <div class="field"><div class="field-head"><label>Centres d'intérêt</label>${srcMini(f,'hobby')}</div><input type="text" value="${esc(f.hobby)}" oninput="form_.hobby=this.value"></div>
    </div>
    <div class="field" style="margin-top:14px"><div class="field-head"><label>Remarques</label>${srcMini(f,'remarks')}</div><textarea oninput="form_.remarks=this.value">${esc(f.remarks)}</textarea></div>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='institutions' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title"><span class="section-num">3</span><h3>Institutions</h3></div>
    <p class="section-sub">Créez ou complétez ici les institutions (nom, type, adresse) avant de les choisir dans une liste déroulante en Parcours professionnel et Formation.</p>
    <div id="form-inst-tab">${renderInstitutionsTab()}</div>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='trajectories' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">4</span><h3>Parcours professionnel</h3>
      ${sectionDefaultSourceControl('trajectories')}
    </div>
    <p class="section-sub">Une entrée = un poste occupé. Décochez « Fonction principale » pour un rôle secondaire (ex. administrateur, membre de comité). Chaque événement (début, fin…) a sa propre source.</p>
    <div id="traj-list">${renderTrajList()}</div>
    <button id="traj-add-btn" class="add-row-btn" onclick="addTrajectory()">+ Ajouter une étape de carrière</button>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='educations' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">5</span><h3>Formation</h3>
      ${sectionDefaultSourceControl('educations')}
    </div>
    <div id="edu-list">${renderEduList()}</div>
    <button class="add-row-btn" onclick="addEducation()">+ Ajouter une formation</button>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='distinctions' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">6</span><h3>Distinctions</h3>
      ${sectionDefaultSourceControl('distinctions')}
    </div>
    <div id="dist-list">${renderDistList()}</div>
    <button class="add-row-btn" onclick="addDistinction()">+ Ajouter une distinction</button>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='relatives' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">7</span><h3>Parenté</h3>
      ${sectionDefaultSourceControl('relatives')}
    </div>
    <p class="section-sub">Parents et conjoint(s). Les enfants ne sont pas consignés dans cette base.</p>
    <div id="rel-list">${renderRelList()}</div>
    <button class="add-row-btn" onclick="addRelative()">+ Ajouter un proche</button>
  </div>
  </div>

  <div class="form-footer">
    <span id="autosave-status" class="hint">${esc(state.autoSaveStatus)}</span>
    <div>
      <button class="ghost" onclick="backToDashboard()">Annuler</button>
      <button class="primary" onclick="saveCV()">${isEdit?'Enregistrer les modifications':'Enregistrer le CV'}</button>
    </div>
  </div>
  <div id="nationality-modal-root">${renderNationalityModal()}</div>
  `;
}

function switchFormTab(tab){
  state.formTab = tab;
  rerenderForm();
  if(tab === 'institutions') loadFormInstitutions();
}

/* ---------- Bouton "source par défaut" pour une section entière ---------- */

function sectionDefaultSourceControl(sectionKey){
  return `<div class="section-default-src">
    <input type="text" class="field-source-mini" list="dl-datasources" id="defsrc-${sectionKey}"
      placeholder="fichier par défaut" title="Fichier source par défaut pour cette section"
      onfocus="dsFocus(this)" onblur="dsBlur(this)">
    <button class="small ghost" onclick="applyDefaultSource('${sectionKey}', document.getElementById('defsrc-${sectionKey}').value)">Appliquer à la section</button>
  </div>`;
}

function applyDefaultSource(sectionKey, value){
  value = (value || '').trim();
  if(!value){ showToast("Tapez ou choisissez un fichier source avant d'appliquer."); return; }
  const f = state.form;
  if(sectionKey === 'identity'){
    if(!f.fieldSources) f.fieldSources = {};
    IDENTITY_SOURCE_FIELDS.forEach(k => { if(!f.fieldSources[k]) f.fieldSources[k] = value; });
  } else if(sectionKey === 'nationalities'){
    (f.nationalities || []).forEach(n => { if(!n.dataSource) n.dataSource = value; });
  } else if(sectionKey === 'trajectories'){
    (f.trajectories || []).forEach(t => (t.events || []).forEach(ev => { if(!ev.dataSource) ev.dataSource = value; }));
  } else if(sectionKey === 'educations'){
    (f.educations || []).forEach(e => { if(!e.dataSource) e.dataSource = value; });
  } else if(sectionKey === 'distinctions'){
    (f.distinctions || []).forEach(d => { if(!d.dataSource) d.dataSource = value; });
  } else if(sectionKey === 'relatives'){
    (f.relatives || []).forEach(r => { if(!r.dataSource) r.dataSource = value; });
  }
  scheduleAutoSave();
  showToast('Source par défaut appliquée aux champs encore vides de cette section.');
  rerenderForm();
}

/* ---------- Mini-sélecteur de source, par champ (section Identité) ---------- */

// Les champs "source" utilisent une liste déroulante (datalist) : la plupart
// des navigateurs ne réaffichent pas la liste complète des options si le
// champ contient déjà une valeur (ils filtrent sur ce qui est tapé). On vide
// donc le champ au clic pour montrer toutes les sources disponibles, puis on
// restaure la valeur d'origine si l'utilisateur ressort sans rien choisir.
function dsFocus(el){
  el.dataset.prev = el.value;
  el.value = '';
  el.dataset.touched = '0';
}
function dsBlur(el){
  if(el.dataset.touched !== '1' && el.value === '' && el.dataset.prev) el.value = el.dataset.prev;
}

function srcMini(f, field){
  const val = (f.fieldSources && f.fieldSources[field]) || '';
  return `<input type="text" class="field-source-mini" list="dl-datasources" placeholder="fichier" title="Fichier source pour ce champ"
    value="${esc(val)}" onfocus="dsFocus(this)" onblur="dsBlur(this)"
    oninput="fieldSourceSet('${field}',this.value); this.dataset.touched='1';">`;
}
function fieldSourceSet(field, value){
  if(!state.form.fieldSources) state.form.fieldSources = {};
  state.form.fieldSources[field] = value;
  scheduleAutoSave();
}

/* ---------- Sous-section : nationalité(s) ---------- */

function renderNatList(){
  if(state.form.nationalities.length===0) return `<p class="hint">Aucune nationalité ajoutée.</p>`;
  return state.form.nationalities.map((n,i) => `
    <div class="repeat-item">
      <div class="repeat-item-head">
        <span>Nationalité ${i+1}</span>
        <button class="small ghost" onclick="removeNationality(${i})">Retirer</button>
      </div>
      <div class="grid grid-3">
        <div class="field"><label>Pays *</label><input type="text" list="dl-countries" required value="${esc(n.country)}" oninput="natSet(${i},'country',this.value)"></div>
        <div class="field"><label>Année d'obtention</label><input type="number" value="${esc(n.obtentionYear)}" oninput="natSet(${i},'obtentionYear',this.value)"></div>
        <div class="field"><label>Année de perte</label><input type="number" value="${esc(n.lossYear)}" oninput="natSet(${i},'lossYear',this.value)"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Fichier source</label>
        <input type="text" list="dl-datasources" value="${esc(n.dataSource)}" onfocus="dsFocus(this)" onblur="dsBlur(this)"
          oninput="natSet(${i},'dataSource',this.value); this.dataset.touched='1';">
      </div>
    </div>
  `).join('');
}
function renderNatListInPlace(){ document.getElementById('nat-list').innerHTML = renderNatList(); }
function natSet(i,field,value){ state.form.nationalities[i][field]=value; scheduleAutoSave(); }
function addNationality(){ state.form.nationalities.push(blankNationality()); renderNatListInPlace(); scheduleAutoSave(); }
function removeNationality(i){ state.form.nationalities.splice(i,1); renderNatListInPlace(); scheduleAutoSave(); }

function nationalitySummary(){
  const list = (state.form.nationalities || []).map(n => n.country).filter(Boolean);
  return list.length ? ` — ${esc(list.join(', '))}` : '';
}

/* ---------- Popup : nationalité(s), depuis la section Identité ---------- */

let nationalityModalOpen = false;

function openNationalityModal(){
  nationalityModalOpen = true;
  renderNationalityModalInPlace();
}
function closeNationalityModal(){
  nationalityModalOpen = false;
  renderNationalityModalInPlace();
  // Le résumé affiché sur le bouton (liste des pays) peut avoir changé.
  const btnHost = document.querySelector('[onclick^="openNationalityModal"]');
  if(btnHost) btnHost.innerHTML = `🌍 Nationalité(s)${nationalitySummary()}`;
  scheduleAutoSave();
}
function renderNationalityModalInPlace(){
  const el = document.getElementById('nationality-modal-root');
  if(el) el.innerHTML = renderNationalityModal();
}
function renderNationalityModal(){
  if(!nationalityModalOpen) return '';
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeNationalityModal()">
    <div class="modal-panel">
      <div class="modal-header">
        <h3>Nationalité(s)</h3>
        <button class="ghost" onclick="closeNationalityModal()">✕</button>
      </div>
      <p class="section-sub" style="margin-top:-6px">Une ou plusieurs nationalités, seulement si explicitement mentionnées (jamais déduites du seul lieu de naissance).</p>
      ${sectionDefaultSourceControl('nationalities')}
      <div id="nat-list" style="margin-top:10px">${renderNatList()}</div>
      <button class="add-row-btn" onclick="addNationality()">+ Ajouter une nationalité</button>
      <div class="form-footer" style="margin-top:16px;border-top:none;padding-top:0">
        <span></span>
        <button class="primary" onclick="closeNationalityModal()">Fermer</button>
      </div>
    </div>
  </div>`;
}

/* ---------- Sous-section : sources du CV (documents) ---------- */

function renderSourcesList(){
  if(state.form.sources.length===0) return `<p class="hint">Aucune source ajoutée.</p>`;
  return state.form.sources.map((s,i) => `
    <div class="repeat-item">
      <div class="repeat-item-head">
        <span>Source ${i+1}</span>
        ${state.form.sources.length>1 ? `<button class="small ghost" onclick="removeSource(${i})">Retirer</button>` : ''}
      </div>
      <div class="grid grid-2">
        <div class="field"><label>Nom du fichier *</label><input type="text" required value="${esc(s.filename)}" oninput="sourceSet(${i},'filename',this.value)"></div>
        <div class="field"><label>Nom de la source</label><input type="text" placeholder="ex. prénom nom source 2025" value="${esc(s.name)}" oninput="sourceSet(${i},'name',this.value)"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Remarques sur la source</label><textarea oninput="sourceSet(${i},'remarks',this.value)">${esc(s.remarks)}</textarea></div>
    </div>
  `).join('');
}
function renderSourcesListInPlace(){ document.getElementById('sources-list').innerHTML = renderSourcesList(); }
function sourceSet(i,field,value){ state.form.sources[i][field]=value; if(field==='filename') refreshDataSourceDatalist(); scheduleAutoSave(); }
function addSource(){ state.form.sources.push(blankSource()); renderSourcesListInPlace(); refreshDataSourceDatalist(); scheduleAutoSave(); }
function removeSource(i){ state.form.sources.splice(i,1); renderSourcesListInPlace(); refreshDataSourceDatalist(); scheduleAutoSave(); }

// Les autres sections proposent, dans leur champ "fichier source", les noms
// déjà saisis dans l'onglet Sources du CV : on tient ce <datalist> à jour
// dès qu'on ajoute/retire/renomme un fichier, sans attendre un changement
// d'onglet (qui, lui, régénère de toute façon tout le formulaire).
function refreshDataSourceDatalist(){
  const el = document.getElementById('dl-datasources');
  if(!el || !state.form) return;
  const names = state.form.sources.map(s => s.filename).filter(Boolean);
  el.innerHTML = names.map(v => `<option value="${esc(v)}">`).join('');
}

// Raccourci pour les inputs : on écrit directement dans state.form. Le Proxy
// déclenche automatiquement la sauvegarde différée à chaque écriture, sans
// devoir modifier chaque attribut oninput un par un.
let formProxy = null;
let formProxyTarget = null;
Object.defineProperty(window, 'form_', {
  get(){
    if(formProxy && formProxyTarget === state.form) return formProxy;
    formProxyTarget = state.form;
    formProxy = new Proxy(state.form, {
      set(target, prop, value){ target[prop] = value; scheduleAutoSave(); return true; },
    });
    return formProxy;
  },
});

function datalists(){
  const r = state.referentials || {};
  const opt = arr => (arr||[]).map(v => `<option value="${esc(v)}">`).join('');
  // Les champs "fichier source" partout dans le formulaire proposent les
  // noms de fichiers déjà saisis dans l'onglet Sources du CV de CETTE
  // fiche — pas une liste globale : on ne référence plus un simple libellé
  // ("LinkedIn") mais le document précis utilisé pour cette information.
  const sourceFilenames = (state.form ? state.form.sources : []).map(s => s.filename).filter(Boolean);
  let html = `
    <datalist id="dl-positions">${opt(r.positions)}</datalist>
    <datalist id="dl-institutions">${opt(r.institutions)}</datalist>
    <datalist id="dl-arenas">${opt(r.arenas)}</datalist>
    <datalist id="dl-professions">${opt(r.professions)}</datalist>
    <datalist id="dl-municipalities">${opt(r.municipalities)}</datalist>
    <datalist id="dl-countries">${opt(r.countries)}</datalist>
    <datalist id="dl-birthcountries">${opt(r.birthCountries)}</datalist>
    <datalist id="dl-diplomas">${opt(r.diplomas)}</datalist>
    <datalist id="dl-disciplines">${opt(r.disciplines)}</datalist>
    <datalist id="dl-grades">${opt(r.grades)}</datalist>
    <datalist id="dl-relativetypes">${opt(r.relativeTypes)}</datalist>
    <datalist id="dl-institutiontypes">${opt(r.institutionTypes)}</datalist>
    <datalist id="dl-events">${opt(r.events)}</datalist>
    <datalist id="dl-datasources">${opt(sourceFilenames)}</datalist>
  `;
  return html;
}

/* ---------- Sous-section : parcours professionnel ---------- */

function renderTrajList(){
  return state.form.trajectories.map((t,i) => `
    <div class="repeat-item">
      <div class="repeat-item-head">
        <span>Étape ${i+1}</span>
        ${state.form.trajectories.length>1 ? `<button class="small ghost" onclick="removeTrajectory(${i})">Retirer</button>` : ''}
      </div>
      <div class="grid grid-2">
        <div class="field"><label>Poste</label><input type="text" list="dl-positions" value="${esc(t.position)}" oninput="trajSet(${i},'position',this.value)"></div>
        <div class="field"><label>Institution</label><input type="text" list="dl-institutions" value="${esc(t.institution)}" oninput="trajSet(${i},'institution',this.value)"></div>
      </div>
      <p class="hint" style="margin-top:2px">Adresse et type d'institution : à gérer sur la page « Institutions ».</p>
      <div class="grid grid-2" style="margin-top:10px">
        <div class="field"><label>Arène</label><input type="text" list="dl-arenas" value="${esc(t.arena)}" oninput="trajSet(${i},'arena',this.value)"></div>
        <div class="field"><label>Lieu de travail</label><input type="text" value="${esc(t.workPlace)}" oninput="trajSet(${i},'workPlace',this.value)"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Détail du poste</label><textarea oninput="trajSet(${i},'positionDetails',this.value)">${esc(t.positionDetails)}</textarea></div>
      <div class="field" style="margin-top:10px"><label>Remarques</label><textarea oninput="trajSet(${i},'remarks',this.value)">${esc(t.remarks)}</textarea></div>
      <div style="margin-top:10px">
        <label>Événements (dates, nature, détail)</label>
        <div id="events-${i}">${renderEventRows(i, t.events)}</div>
        <button class="small" onclick="addEvent(${i})">+ Ajouter un événement</button>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="principal-${i}" ${t.principal?'checked':''} onchange="trajSet(${i},'principal',this.checked)">
        <label for="principal-${i}">Fonction principale (décocher si secondaire, ex. administrateur, membre de comité)</label>
      </div>
    </div>
  `).join('');
}

// Les 3 natures possibles (Début / Fin / En cours) et leur code interne —
// utilisé dans les deux sens ci-dessous.
const NATURE_DEFAULT_LABELS = { '1':'Début', '2':'Fin', '3':'En cours' };
const NATURE_LABEL_TO_CODE = { 'début':'1', 'debut':'1', 'fin':'2', 'en cours':'3' };

// Quand on tape/choisit un événement dans le champ Événement, sa nature est
// déduite automatiquement, dans deux cas :
//  1) le texte tapé est justement l'un des 3 libellés fixes (Début/Fin/En
//     cours) — reconnu immédiatement, sans dépendre de données déjà
//     enregistrées ;
//  2) le texte correspond à un événement précis déjà utilisé ailleurs dans
//     la base (ex. « Nomination »), dont la nature est alors reprise depuis
//     l'historique.
function eventNameChanged(i, j, value){
  eventSet(i, j, 'event', value);
  const byFixedLabel = NATURE_LABEL_TO_CODE[(value || '').trim().toLowerCase()];
  const natures = (state.referentials && state.referentials.eventNatures) || {};
  const known = byFixedLabel || natures[value];
  if(known){
    state.form.trajectories[i].events[j].nature = known;
    renderEventRowsInPlace(i);
  }
}

// À l'inverse, choisir directement une Nature (Début / En cours / Fin) —
// par exemple sur un tout nouvel événement — pré-remplit le champ
// Événement avec ce même libellé par défaut, sans écraser un texte déjà
// saisi (ex. « Nomination ») : juste un point de départ à préciser si besoin.
function eventNatureChanged(i, j, value){
  eventSet(i, j, 'nature', value);
  const ev = state.form.trajectories[i].events[j];
  if(!(ev.event || '').trim() && NATURE_DEFAULT_LABELS[value]){
    ev.event = NATURE_DEFAULT_LABELS[value];
    renderEventRowsInPlace(i);
  }
}

function renderEventRows(i, events){
  return events.map((e,j) => `
    <div class="event-row">
      <div class="field field-day"><label>Jour</label><input type="number" min="1" max="31" value="${esc(e.day)}" oninput="eventSet(${i},${j},'day',this.value)"></div>
      <div class="field field-month"><label>Mois</label><input type="number" min="1" max="12" value="${esc(e.month)}" oninput="eventSet(${i},${j},'month',this.value)"></div>
      <div class="field field-year"><label>Année</label><input type="number" value="${esc(e.year)}" oninput="eventSet(${i},${j},'year',this.value)"></div>
      <div class="field field-nature"><label>Nature</label>
        <select onchange="eventNatureChanged(${i},${j},this.value)">
          <option value="1" ${e.nature==='1'?'selected':''}>Début</option>
          <option value="2" ${e.nature==='2'?'selected':''}>Fin</option>
          <option value="3" ${e.nature==='3'?'selected':''}>En cours</option>
        </select>
      </div>
      <div class="field field-event"><label>Événement</label><input type="text" list="dl-events" value="${esc(e.event)}" oninput="eventNameChanged(${i},${j},this.value)"></div>
      ${events.length>1 ? `<button class="small ghost" onclick="removeEvent(${i},${j})" title="Retirer cet événement">✕</button>` : ''}
      <div class="field field-event-src">
        <label>Fichier source</label>
        <input type="text" class="field-source-mini" list="dl-datasources" value="${esc(e.dataSource)}"
          onfocus="dsFocus(this)" onblur="dsBlur(this)"
          oninput="eventSet(${i},${j},'dataSource',this.value); this.dataset.touched='1';">
      </div>
    </div>
  `).join('');
}
function renderEventRowsInPlace(i){
  document.getElementById(`events-${i}`).innerHTML = renderEventRows(i, state.form.trajectories[i].events);
}
function renderTrajListInPlace(){ document.getElementById('traj-list').innerHTML = renderTrajList(); }
function trajSet(i,field,value){ state.form.trajectories[i][field] = value; scheduleAutoSave(); }
function addTrajectory(){ state.form.trajectories.push(blankTrajectory()); renderTrajListInPlace(); scheduleAutoSave(); }
function removeTrajectory(i){ state.form.trajectories.splice(i,1); renderTrajListInPlace(); scheduleAutoSave(); }
function eventSet(i,j,field,value){ state.form.trajectories[i].events[j][field] = value; scheduleAutoSave(); }
function addEvent(i){ state.form.trajectories[i].events.push(blankEvent()); renderEventRowsInPlace(i); scheduleAutoSave(); }
function removeEvent(i,j){ state.form.trajectories[i].events.splice(j,1); renderEventRowsInPlace(i); scheduleAutoSave(); }

/* ---------- Sous-section : formation ---------- */

function renderEduList(){
  if(state.form.educations.length===0) return `<p class="hint">Aucune formation ajoutée.</p>`;
  return state.form.educations.map((e,i) => `
    <div class="repeat-item">
      <div class="repeat-item-head"><span>Formation ${i+1}</span><button class="small ghost" onclick="removeEducation(${i})">Retirer</button></div>
      <div class="grid grid-2">
        <div class="field"><label>École / université</label><input type="text" list="dl-institutions" value="${esc(e.school)}" oninput="eduSet(${i},'school',this.value)"></div>
        <div class="field"><label>Diplôme</label><input type="text" list="dl-diplomas" value="${esc(e.diploma)}" oninput="eduSet(${i},'diploma',this.value)"></div>
        <div class="field"><label>Discipline</label><input type="text" list="dl-disciplines" value="${esc(e.discipline)}" oninput="eduSet(${i},'discipline',this.value)"></div>
        <div class="field"><label>Grade obtenu</label><input type="text" list="dl-grades" value="${esc(e.grade)}" oninput="eduSet(${i},'grade',this.value)"></div>
        <div class="field"><label>Année de début</label><input type="number" value="${esc(e.startYear)}" oninput="eduSet(${i},'startYear',this.value)"></div>
        <div class="field"><label>Année de fin</label><input type="number" value="${esc(e.endYear)}" oninput="eduSet(${i},'endYear',this.value)"></div>
      </div>
      <p class="hint" style="margin-top:2px">Adresse et type d'établissement : à gérer sur la page « Institutions ».</p>
      <div class="field" style="margin-top:10px"><label>Remarques (ex. promotion)</label><input type="text" value="${esc(e.remarks)}" oninput="eduSet(${i},'remarks',this.value)"></div>
      <div class="checkbox-row"><input type="checkbox" id="initial-${i}" ${e.initial?'checked':''} onchange="eduSet(${i},'initial',this.checked)"><label for="initial-${i}">Formation initiale</label></div>
      <div class="field" style="margin-top:10px"><label>Fichier source</label><input type="text" list="dl-datasources" value="${esc(e.dataSource)}" onfocus="dsFocus(this)" onblur="dsBlur(this)" oninput="eduSet(${i},'dataSource',this.value); this.dataset.touched='1';"></div>
    </div>
  `).join('');
}
function renderEduListInPlace(){ document.getElementById('edu-list').innerHTML = renderEduList(); }
function eduSet(i,field,value){ state.form.educations[i][field]=value; scheduleAutoSave(); }
function addEducation(){ state.form.educations.push(blankEducation()); renderEduListInPlace(); scheduleAutoSave(); }
function removeEducation(i){ state.form.educations.splice(i,1); renderEduListInPlace(); scheduleAutoSave(); }

/* ---------- Sous-section : distinctions ---------- */

function renderDistList(){
  if(state.form.distinctions.length===0) return `<p class="hint">Aucune distinction ajoutée.</p>`;
  return state.form.distinctions.map((d,i) => `
    <div class="repeat-item">
      <div class="repeat-item-head"><span>Distinction ${i+1}</span><button class="small ghost" onclick="removeDistinction(${i})">Retirer</button></div>
      <div class="grid grid-2">
        <div class="field"><label>Année</label><input type="number" value="${esc(d.year)}" oninput="distSet(${i},'year',this.value)"></div>
        <div class="field"><label>Description</label><input type="text" value="${esc(d.description)}" oninput="distSet(${i},'description',this.value)"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Remarques</label><input type="text" value="${esc(d.remarks)}" oninput="distSet(${i},'remarks',this.value)"></div>
      <div class="field" style="margin-top:10px"><label>Fichier source</label><input type="text" list="dl-datasources" value="${esc(d.dataSource)}" onfocus="dsFocus(this)" onblur="dsBlur(this)" oninput="distSet(${i},'dataSource',this.value); this.dataset.touched='1';"></div>
    </div>
  `).join('');
}
function renderDistListInPlace(){ document.getElementById('dist-list').innerHTML = renderDistList(); }
function distSet(i,field,value){ state.form.distinctions[i][field]=value; scheduleAutoSave(); }
function addDistinction(){ state.form.distinctions.push(blankDistinction()); renderDistListInPlace(); scheduleAutoSave(); }
function removeDistinction(i){ state.form.distinctions.splice(i,1); renderDistListInPlace(); scheduleAutoSave(); }

/* ---------- Sous-section : parenté ---------- */

function renderRelList(){
  if(state.form.relatives.length===0) return `<p class="hint">Aucun proche ajouté.</p>`;
  return state.form.relatives.map((r,i) => `
    <div class="repeat-item">
      <div class="repeat-item-head"><span>Proche ${i+1}</span><button class="small ghost" onclick="removeRelative(${i})">Retirer</button></div>
      <div class="grid grid-2">
        <div class="field"><label>Prénom</label><input type="text" value="${esc(r.firstname)}" oninput="relSet(${i},'firstname',this.value)"></div>
        <div class="field"><label>Nom</label><input type="text" value="${esc(r.lastname)}" oninput="relSet(${i},'lastname',this.value)"></div>
        <div class="field"><label>Lien de parenté</label><input type="text" list="dl-relativetypes" value="${esc(r.relationType)}" oninput="relSet(${i},'relationType',this.value)"></div>
        <div class="field"><label>Fonction du proche (optionnel)</label><input type="text" list="dl-professions" value="${esc(r.profession)}" oninput="relSet(${i},'profession',this.value)"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Fichier source</label><input type="text" list="dl-datasources" value="${esc(r.dataSource)}" onfocus="dsFocus(this)" onblur="dsBlur(this)" oninput="relSet(${i},'dataSource',this.value); this.dataset.touched='1';"></div>
    </div>
  `).join('');
}
function renderRelListInPlace(){ document.getElementById('rel-list').innerHTML = renderRelList(); }
function relSet(i,field,value){ state.form.relatives[i][field]=value; scheduleAutoSave(); }
function addRelative(){ state.form.relatives.push(blankRelative()); renderRelListInPlace(); scheduleAutoSave(); }
function removeRelative(i){ state.form.relatives.splice(i,1); renderRelListInPlace(); scheduleAutoSave(); }

/* ---------- Vérification d'unicité (avertissement, non bloquant) ---------- */

async function checkDuplicates(){
  const cn = (state.form.commonName||'').trim();
  const uf = (state.form.usualFirstname||'').trim();
  if(!cn && !uf){ state.duplicates=[]; document.getElementById('dup-warning').innerHTML=''; return; }
  try{
    const qs = `?commonName=${encodeURIComponent(cn)}&usualFirstname=${encodeURIComponent(uf)}` +
               (state.editingPK ? `&exclude=${state.editingPK}` : '');
    state.duplicates = await api('check-duplicates' + qs);
  }catch(e){
    state.duplicates = [];
  }
  const el = document.getElementById('dup-warning');
  if(el) el.innerHTML = renderDuplicateWarningHtml();
}

function renderDuplicateWarningHtml(){
  if(!state.duplicates || state.duplicates.length===0) return '';
  return `
  <div class="warning-box">
    <div class="wtitle">Une fiche existe déjà pour ce nom</div>
    <ul>
      ${state.duplicates.map(d => `<li>${esc(d.firstname)} ${esc(d.lastname)} — <span class="mono">IND·${String(d.pk).padStart(3,'0')}</span></li>`).join('')}
    </ul>
    Une même personne ne peut avoir qu'une seule fiche : ouvrez la fiche existante pour la compléter ou la corriger plutôt que d'en créer une nouvelle.
    <div class="wactions">
      ${state.duplicates.map(d => `<button class="small" onclick="openEditForm(${d.pk})">Ouvrir IND·${String(d.pk).padStart(3,'0')}</button>`).join('')}
    </div>
  </div>`;
}

/* ============================================================
   ENREGISTREMENT
   ============================================================ */

/* ============================================================
   SAUVEGARDE AUTOMATIQUE
   ============================================================ */

let autoSaveTimer = null;
let autoSaveInFlight = false;

function scheduleAutoSave(){
  if(state.screen !== 'form' || !state.form) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(runAutoSave, 20000);
}

function clearAutoSave(){
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}

function setAutoSaveStatus(text){
  state.autoSaveStatus = text;
  const el = document.getElementById('autosave-status');
  if(el) el.textContent = text;
}

function hasAtLeastOneSourceFile(f){
  return (f.sources||[]).some(s => (s.filename||'').trim());
}

async function runAutoSave(){
  if(state.screen !== 'form' || !state.form) return;
  const f = state.form;
  // On n'auto-sauvegarde que si le minimum requis est déjà rempli — sinon le
  // serveur refuserait de toute façon, inutile d'insister en silence.
  if(!f.commonName.trim() || !f.usualFirstname.trim() || !f.genre || !hasAtLeastOneSourceFile(f)) return;
  if(autoSaveInFlight){ scheduleAutoSave(); return; }
  autoSaveInFlight = true;
  setAutoSaveStatus('Enregistrement…');
  try{
    const res = await api('individual', {
      method:'POST',
      body: JSON.stringify({ user: state.user, editingPK: state.editingPK, form: f, silent: true }),
    });
    if(res && res.pk){
      state.editingPK = res.pk;  // les sauvegardes suivantes deviennent des mises à jour
      const now = new Date();
      const hh = String(now.getHours()).padStart(2,'0'), mm = String(now.getMinutes()).padStart(2,'0');
      setAutoSaveStatus(`Enregistré automatiquement à ${hh}:${mm}`);
    }
  }catch(e){
    // Échec silencieux (doublon détecté, champs pas encore valides, etc.) —
    // on ne dérange pas l'utilisateur en pleine saisie ; le bouton
    // "Enregistrer" reste disponible pour un retour explicite si besoin.
    setAutoSaveStatus('');
  }finally{
    autoSaveInFlight = false;
  }
}

async function flushAutoSave(){
  clearAutoSave();
  if(state.screen === 'form' && state.form) await runAutoSave();
}

async function saveCV(){
  clearAutoSave();
  const f = state.form;
  if(!f.commonName.trim() || !f.usualFirstname.trim() || !f.genre || !hasAtLeastOneSourceFile(f)){
    state.statusMsg = { type:'error', text:"Merci de renseigner au minimum le nom d'usage affiché, le prénom, le genre et le nom d'au moins un fichier source." };
    rerenderForm();
    return;
  }
  try{
    await api('individual', {
      method:'POST',
      body: JSON.stringify({ user: state.user, editingPK: state.editingPK, form: f }),
    });
    showToast(state.editingPK ? 'Modifications enregistrées.' : 'CV enregistré.');
    backToDashboard();
  }catch(e){
    if(e.payload && e.payload.duplicates && e.payload.duplicates.length){
      state.duplicates = e.payload.duplicates;
    }
    state.statusMsg = { type:'error', text: e.message };
    rerenderForm();
  }
}

/* ============================================================
   DÉMARRAGE
   ============================================================ */
render();