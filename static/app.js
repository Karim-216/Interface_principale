/* ============================================================
   DIRIVA — Interface de saisie manuelle de CV (frontend)
   Parle au backend Flask via l'API REST /api/... — aucune logique
   métier ici, seulement l'affichage et les appels réseau.
   ============================================================ */

const APP_LABEL = 'Diriva';
const DATA_SOURCE_TYPES = window.DATA_SOURCE_TYPES || [];

// Champs de la section Identité qui ont chacun leur propre repère de source
// (voir srcMini / fieldSourceSet) — réutilisé par le bouton "source par
// défaut pour cette section".
const IDENTITY_SOURCE_FIELDS = [
  'commonName','usualFirstname','otherFirstname','marriedName','birthName','genre',
  'birthDay','birthMonth','birthYear','birthPlace','birthCountry','profession','hobby','remarks',
];

// Onglets du formulaire, dans l'ordre d'affichage.
const FORM_TABS = [
  { key:'identity',      label:'Identité' },
  { key:'sources',       label:'Sources du CV' },
  { key:'trajectories',  label:'Parcours professionnel' },
  { key:'educations',    label:'Formation' },
  { key:'distinctions',  label:'Distinctions' },
  { key:'relatives',     label:'Parenté' },
];

const state = {
  screen: 'login',       // login | dashboard | form | history
  user: '',
  list: [],
  search: '',
  referentials: null,
  editingPK: null,
  form: null,
  formTab: 'identity',
  duplicates: [],
  statusMsg: null,
  confirmDeletePK: null,
  historyEntries: [],
  historyFilterPK: null,
  loading: false,
  autoSaveStatus: '',    // texte affiché près du bouton Enregistrer
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

function render(){
  const app = document.getElementById('app');
  if(state.screen==='login') app.innerHTML = viewLogin();
  else if(state.screen==='dashboard') app.innerHTML = viewTopbar() + viewDashboard();
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
  return { position:'', institution:'', institutionType:1, institutionCity:'', institutionCountry:'', institutionStreet:'', institutionStreetNumber:'', institutionRemarks:'',
           arena:'Fonction Exécutive', positionDetails:'', remarks:'', workPlace:'',
           principal:true, events:[ blankEvent() ] };
}
function blankEvent(){
  return { day:'', month:'', year:'', nature:'1', event:'', dataSource:'' };
}
function blankEducation(){
  return { school:'', schoolCity:'', schoolCountry:'', schoolStreet:'', schoolStreetNumber:'', schoolRemarks:'',
           diploma:'', discipline:'', grade:'', startYear:'', endYear:'', initial:true, remarks:'', dataSource:'' };
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
  state.formTab = 'identity';
  state.duplicates = [];
  state.statusMsg = null;
  state.autoSaveStatus = '';
  addressModalState = null;
  nationalityModalOpen = false;
  state.screen = 'form';
  render();
  await ensureReferentials();
  rerenderForm();
}

async function openEditForm(pk){
  state.editingPK = pk;
  state.formTab = 'identity';
  state.duplicates = [];
  state.statusMsg = null;
  state.autoSaveStatus = '';
  addressModalState = null;
  nationalityModalOpen = false;
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

  <div class="tab-panel" ${state.formTab!=='identity' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">1</span><h3>Identité</h3>
      ${sectionDefaultSourceControl('identity')}
    </div>
    <p class="section-sub">Chaque champ a son propre repère de source (ex. le nom d'usage vient de LinkedIn, le nom de naissance de LesBiographies) — à remplir quand deux sources ne disent pas la même chose.</p>
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
    <div class="grid grid-3" style="margin-top:14px">
      <div class="field"><div class="field-head"><label>Jour de naissance</label>${srcMini(f,'birthDay')}</div><input type="number" min="1" max="31" value="${esc(f.birthDay)}" oninput="form_.birthDay=this.value"></div>
      <div class="field"><div class="field-head"><label>Mois de naissance</label>${srcMini(f,'birthMonth')}</div><input type="number" min="1" max="12" value="${esc(f.birthMonth)}" oninput="form_.birthMonth=this.value"></div>
      <div class="field"><div class="field-head"><label>Année de naissance</label>${srcMini(f,'birthYear')}</div><input type="number" value="${esc(f.birthYear)}" oninput="form_.birthYear=this.value"></div>
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

  <div class="tab-panel" ${state.formTab!=='sources' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title"><span class="section-num">2</span><h3>Sources du CV</h3></div>
    <p class="section-sub">Un ou plusieurs documents source (LinkedIn, Who's Who, LesBiographies…) ayant servi à cette fiche.</p>
    <div id="sources-list">${renderSourcesList()}</div>
    <button class="add-row-btn" onclick="addSource()">+ Ajouter une source</button>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='trajectories' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">3</span><h3>Parcours professionnel</h3>
      ${sectionDefaultSourceControl('trajectories')}
    </div>
    <p class="section-sub">Une entrée = un poste occupé. Cochez « poste actuel » si la personne l'occupe encore. Chaque événement (début, fin…) a sa propre source.</p>
    <div id="traj-list">${renderTrajList()}</div>
    <button id="traj-add-btn" class="add-row-btn" onclick="addTrajectory()">+ Ajouter une étape de carrière</button>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='educations' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">4</span><h3>Formation</h3>
      ${sectionDefaultSourceControl('educations')}
    </div>
    <div id="edu-list">${renderEduList()}</div>
    <button class="add-row-btn" onclick="addEducation()">+ Ajouter une formation</button>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='distinctions' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">5</span><h3>Distinctions</h3>
      ${sectionDefaultSourceControl('distinctions')}
    </div>
    <div id="dist-list">${renderDistList()}</div>
    <button class="add-row-btn" onclick="addDistinction()">+ Ajouter une distinction</button>
  </div>
  </div>

  <div class="tab-panel" ${state.formTab!=='relatives' ? 'hidden' : ''}>
  <div class="panel section">
    <div class="section-title">
      <span class="section-num">6</span><h3>Parenté</h3>
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
  <div id="institution-modal-root">${renderInstitutionModal()}</div>
  <div id="nationality-modal-root">${renderNationalityModal()}</div>
  `;
}

function switchFormTab(tab){
  state.formTab = tab;
  rerenderForm();
}

/* ---------- Bouton "source par défaut" pour une section entière ---------- */

function sectionDefaultSourceControl(sectionKey){
  return `<div class="section-default-src">
    <input type="text" class="field-source-mini" list="dl-datasources" id="defsrc-${sectionKey}"
      placeholder="source par défaut" title="Source par défaut pour cette section"
      onfocus="dsFocus(this)" onblur="dsBlur(this)">
    <button class="small ghost" onclick="applyDefaultSource('${sectionKey}', document.getElementById('defsrc-${sectionKey}').value)">Appliquer à la section</button>
  </div>`;
}

function applyDefaultSource(sectionKey, value){
  value = (value || '').trim();
  if(!value){ showToast("Tapez ou choisissez une source avant d'appliquer."); return; }
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
  return `<input type="text" class="field-source-mini" list="dl-datasources" placeholder="source" title="Source de la saisie pour ce champ"
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
      <div class="field" style="margin-top:10px"><label>Source de la saisie</label>
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
function sourceSet(i,field,value){ state.form.sources[i][field]=value; scheduleAutoSave(); }
function addSource(){ state.form.sources.push(blankSource()); renderSourcesListInPlace(); scheduleAutoSave(); }
function removeSource(i){ state.form.sources.splice(i,1); renderSourcesListInPlace(); scheduleAutoSave(); }

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
    <datalist id="dl-events">${opt(r.events)}</datalist>
    <datalist id="dl-datasources">${opt(r.dataSources)}</datalist>
  `;
  return html;
}

/* ---------- Sous-section : parcours professionnel ---------- */

function institutionInfoSummary(item, prefix){
  prefix = prefix || 'institution';
  const parts = [item[prefix+'City'], item[prefix+'Country']].filter(Boolean);
  return parts.length ? ` — ${esc(parts.join(', '))}` : '';
}

/* ---------- Popup : informations d'institution (adresse + remarques) ---------- */

let addressModalState = null; // { kind:'traj'|'edu', index } ou null

function openInstitutionModal(kind, index){
  addressModalState = { kind, index };
  renderInstitutionModalInPlace();
}
function closeInstitutionModal(){
  addressModalState = null;
  renderInstitutionModalInPlace();
  // Les champs ont pu changer pendant que la popup était ouverte : on
  // rafraîchit la liste (pour mettre à jour le résumé sur le bouton) et on
  // programme une sauvegarde.
  renderTrajListInPlace();
  renderEduListInPlace();
  scheduleAutoSave();
}
function renderInstitutionModalInPlace(){
  const el = document.getElementById('institution-modal-root');
  if(el) el.innerHTML = renderInstitutionModal();
}
function renderInstitutionModal(){
  if(!addressModalState) return '';
  const { kind, index } = addressModalState;
  const isEdu = kind === 'edu';
  const item = isEdu ? state.form.educations[index] : state.form.trajectories[index];
  if(!item) return '';
  const prefix = isEdu ? 'school' : 'institution';
  const setFn = isEdu ? 'eduSet' : 'trajSet';
  const name = item[isEdu ? 'school' : 'institution'] || '(institution non nommée)';
  return `
  <div class="modal-overlay" onclick="if(event.target===this) closeInstitutionModal()">
    <div class="modal-panel">
      <div class="modal-header">
        <h3>${esc(name)}</h3>
        <button class="ghost" onclick="closeInstitutionModal()">✕</button>
      </div>
      <div class="grid grid-2">
        <div class="field"><label>Ville</label><input type="text" list="dl-municipalities" value="${esc(item[prefix+'City'])}" oninput="${setFn}(${index},'${prefix}City',this.value)"></div>
        <div class="field"><label>Pays</label><input type="text" list="dl-countries" value="${esc(item[prefix+'Country'])}" oninput="${setFn}(${index},'${prefix}Country',this.value)"></div>
        <div class="field"><label>Rue</label><input type="text" value="${esc(item[prefix+'Street'])}" oninput="${setFn}(${index},'${prefix}Street',this.value)"></div>
        <div class="field"><label>N°</label><input type="text" value="${esc(item[prefix+'StreetNumber'])}" oninput="${setFn}(${index},'${prefix}StreetNumber',this.value)"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Remarques sur l'institution</label><textarea oninput="${setFn}(${index},'${prefix}Remarks',this.value)">${esc(item[prefix+'Remarks'])}</textarea></div>
      <div class="form-footer" style="margin-top:16px;border-top:none;padding-top:0">
        <span></span>
        <button class="primary" onclick="closeInstitutionModal()">Fermer</button>
      </div>
    </div>
  </div>`;
}

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
      <div style="margin-top:8px">
        <button class="small" onclick="openInstitutionModal('traj',${i})">📍 Infos institution${institutionInfoSummary(t)}</button>
      </div>
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
function renderEventRows(i, events){
  return events.map((e,j) => `
    <div class="event-row">
      <div class="field field-day"><label>Jour</label><input type="number" min="1" max="31" value="${esc(e.day)}" oninput="eventSet(${i},${j},'day',this.value)"></div>
      <div class="field field-month"><label>Mois</label><input type="number" min="1" max="12" value="${esc(e.month)}" oninput="eventSet(${i},${j},'month',this.value)"></div>
      <div class="field field-year"><label>Année</label><input type="number" value="${esc(e.year)}" oninput="eventSet(${i},${j},'year',this.value)"></div>
      <div class="field field-nature"><label>Nature</label>
        <select onchange="eventSet(${i},${j},'nature',this.value)">
          <option value="1" ${e.nature==='1'?'selected':''}>Début</option>
          <option value="2" ${e.nature==='2'?'selected':''}>Fin</option>
          <option value="3" ${e.nature==='3'?'selected':''}>En cours</option>
        </select>
      </div>
      <div class="field field-event"><label>Événement</label><input type="text" list="dl-events" value="${esc(e.event)}" oninput="eventSet(${i},${j},'event',this.value)"></div>
      ${events.length>1 ? `<button class="small ghost" onclick="removeEvent(${i},${j})" title="Retirer cet événement">✕</button>` : ''}
      <div class="field field-event-src">
        <label>Source</label>
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
      <div style="margin-top:8px">
        <button class="small" onclick="openInstitutionModal('edu',${i})">📍 Infos établissement${institutionInfoSummary(e,'school')}</button>
      </div>
      <div class="field" style="margin-top:10px"><label>Remarques (ex. promotion)</label><input type="text" value="${esc(e.remarks)}" oninput="eduSet(${i},'remarks',this.value)"></div>
      <div class="checkbox-row"><input type="checkbox" id="initial-${i}" ${e.initial?'checked':''} onchange="eduSet(${i},'initial',this.checked)"><label for="initial-${i}">Formation initiale</label></div>
      <div class="field" style="margin-top:10px"><label>Source de la saisie</label><input type="text" list="dl-datasources" value="${esc(e.dataSource)}" onfocus="dsFocus(this)" onblur="dsBlur(this)" oninput="eduSet(${i},'dataSource',this.value); this.dataset.touched='1';"></div>
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
      <div class="field" style="margin-top:10px"><label>Source de la saisie</label><input type="text" list="dl-datasources" value="${esc(d.dataSource)}" onfocus="dsFocus(this)" onblur="dsBlur(this)" oninput="distSet(${i},'dataSource',this.value); this.dataset.touched='1';"></div>
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
      <div class="field" style="margin-top:10px"><label>Source de la saisie</label><input type="text" list="dl-datasources" value="${esc(r.dataSource)}" onfocus="dsFocus(this)" onblur="dsBlur(this)" oninput="relSet(${i},'dataSource',this.value); this.dataset.touched='1';"></div>
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