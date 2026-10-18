const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TABS = {
  Personnel: ['id','employee_no','first_name','last_name','department','job_title','email','status','created_at'],
  Expenses: ['id','personnel_id','expense_date','category','description','amount_cents','created_by','created_at']
};
let tokenCache = null;

function config() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const credentialFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(process.env.DATA_DIR || path.join(__dirname,'data'),'google-service-account.json');
  if (!spreadsheetId || !credentialFile) return null;
  const credentials = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
  if (!credentials.client_email || !credentials.private_key) throw new Error('Google service-account file must include client_email and private_key.');
  return { spreadsheetId, credentials };
}

async function accessToken(credentials) {
  if (tokenCache && tokenCache.expires > Date.now() + 60000) return tokenCache.value;
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  const unsigned = `${enc({alg:'RS256',typ:'JWT'})}.${enc({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key,'base64url');
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
  const data = await response.json();
  if (!response.ok) throw new Error(`Google authentication failed: ${data.error_description||data.error||response.status}`);
  tokenCache = {value:data.access_token,expires:Date.now()+Number(data.expires_in||3600)*1000};
  return tokenCache.value;
}

async function googleRequest(cfg, endpoint, options={}) {
  const token = await accessToken(cfg.credentials);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}${endpoint}`,{...options,headers:{Authorization:`Bearer ${token}`,...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
  const data = response.status===204?null:await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(`Google Sheets request failed: ${data.error?.message||response.status}`);
  return data;
}

async function ensureTabs(cfg) {
  const metadata = await googleRequest(cfg,'?fields=sheets.properties.title');
  const existing = new Set((metadata.sheets||[]).map(sheet=>sheet.properties.title));
  const requests = Object.keys(TABS).filter(title=>!existing.has(title)).map(title=>({addSheet:{properties:{title}}}));
  if (requests.length) await googleRequest(cfg,':batchUpdate',{method:'POST',body:JSON.stringify({requests})});
}

async function readTab(cfg, title) {
  const data = await googleRequest(cfg,`/values/${encodeURIComponent(title+'!A1:Z')}`);
  const rows=data.values||[];
  if (!rows.length) return [];
  const headers=rows[0].map(String);
  return rows.slice(1).filter(row=>row.some(value=>String(value??'')!=='')).map(row=>Object.fromEntries(headers.map((key,index)=>[key,row[index]??''])));
}

const n = value => value===''||value==null?null:Number(value);
function recordsFor(db, title) {
  if (title==='Personnel') return db.prepare('SELECT * FROM personnel ORDER BY id').all();
  return db.prepare('SELECT * FROM expenses ORDER BY id').all();
}
function localRows(db) { return {Personnel:recordsFor(db,'Personnel'),Expenses:recordsFor(db,'Expenses')}; }
function rowsForWrite(title,records) { return [TABS[title],...records.map(record=>TABS[title].map(key=>record[key]??''))]; }

async function writeSheets(cfg, data) {
  const clear = Object.keys(TABS).map(title=>`${title}!A:Z`);
  await googleRequest(cfg,'/values:batchClear',{method:'POST',body:JSON.stringify({ranges:clear})});
  const valueRanges=Object.keys(TABS).map(title=>({range:`${title}!A1`,majorDimension:'ROWS',values:rowsForWrite(title,data[title]||[])}));
  await googleRequest(cfg,'/values:batchUpdate',{method:'POST',body:JSON.stringify({valueInputOption:'RAW',data:valueRanges})});
}

function mergeById(local, remote, title) {
  const merged=new Map(local.map(row=>[Number(row.id),row]));
  for (const row of remote) {
    const record={...row,id:n(row.id)};
    if (title==='Personnel') Object.assign(record,{employee_no:String(row.employee_no||''),first_name:String(row.first_name||''),last_name:String(row.last_name||''),department:String(row.department||''),job_title:String(row.job_title||''),email:String(row.email||''),status:String(row.status||'Active'),created_at:String(row.created_at||new Date().toISOString())});
    else Object.assign(record,{personnel_id:n(row.personnel_id),expense_date:String(row.expense_date||''),category:String(row.category||''),description:String(row.description||''),amount_cents:n(row.amount_cents)||0,created_by:n(row.created_by),created_at:String(row.created_at||new Date().toISOString())});
    if(record.id)merged.set(record.id,record);
  }
  return [...merged.values()].sort((a,b)=>a.id-b.id);
}

function importToLocal(db, data) {
  const personnelIds=new Set(data.Personnel.map(row=>Number(row.id)));
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertPerson=db.prepare(`INSERT INTO personnel(id,employee_no,first_name,last_name,department,job_title,email,status,created_at) VALUES(@id,@employee_no,@first_name,@last_name,@department,@job_title,@email,@status,@created_at) ON CONFLICT(id) DO UPDATE SET employee_no=excluded.employee_no,first_name=excluded.first_name,last_name=excluded.last_name,department=excluded.department,job_title=excluded.job_title,email=excluded.email,status=excluded.status,created_at=excluded.created_at`);
    for(const row of data.Personnel) if(row.id&&row.employee_no&&row.first_name)insertPerson.run({id:Number(row.id),employee_no:String(row.employee_no),first_name:String(row.first_name),last_name:String(row.last_name||''),department:String(row.department||''),job_title:String(row.job_title||''),email:String(row.email||''),status:String(row.status||'Active'),created_at:String(row.created_at||new Date().toISOString())});
    const insertExpense=db.prepare(`INSERT INTO expenses(id,personnel_id,expense_date,category,description,amount_cents,created_by,created_at) VALUES(@id,@personnel_id,@expense_date,@category,@description,@amount_cents,@created_by,@created_at) ON CONFLICT(id) DO UPDATE SET personnel_id=excluded.personnel_id,expense_date=excluded.expense_date,category=excluded.category,description=excluded.description,amount_cents=excluded.amount_cents,created_by=excluded.created_by,created_at=excluded.created_at`);
    db.prepare('DELETE FROM expenses').run();
    for(const row of data.Expenses) if(row.id&&personnelIds.has(Number(row.personnel_id))&&row.expense_date&&row.category&&Number(row.amount_cents)>0){ const employee={id:Number(row.id),personnel_id:Number(row.personnel_id),expense_date:String(row.expense_date),category:String(row.category),description:String(row.description||''),amount_cents:Number(row.amount_cents),created_by:row.created_by?Number(row.created_by):null,created_at:String(row.created_at||new Date().toISOString())}; if(employee.created_by&&!db.prepare('SELECT id FROM users WHERE id=?').get(employee.created_by))employee.created_by=null; insertExpense.run(employee); }
    const ids=[...personnelIds];
    if(ids.length) db.prepare(`DELETE FROM personnel WHERE id NOT IN (${ids.map(()=>'?').join(',')}) AND id NOT IN (SELECT personnel_id FROM users WHERE personnel_id IS NOT NULL)`).run(...ids);
    else db.prepare('DELETE FROM personnel WHERE id NOT IN (SELECT personnel_id FROM users WHERE personnel_id IS NOT NULL)').run();
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}

async function initialize(db) {
  const cfg=config();
  if(!cfg)return {enabled:false};
  await ensureTabs(cfg);
  db.exec('CREATE TABLE IF NOT EXISTS google_sheets_sync_meta (id INTEGER PRIMARY KEY CHECK(id=1), initialized INTEGER NOT NULL DEFAULT 0)');
  const remote={Personnel:await readTab(cfg,'Personnel'),Expenses:await readTab(cfg,'Expenses')};
  const initialized=Boolean(db.prepare('SELECT initialized FROM google_sheets_sync_meta WHERE id=1').get()?.initialized);
  if(!initialized){
    const merged={Personnel:mergeById(recordsFor(db,'Personnel'),remote.Personnel,'Personnel'),Expenses:mergeById(recordsFor(db,'Expenses'),remote.Expenses,'Expenses')};
    await writeSheets(cfg,merged); importToLocal(db,merged);
    db.prepare('INSERT INTO google_sheets_sync_meta(id,initialized) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET initialized=1').run();
  } else { importToLocal(db,{Personnel:remote.Personnel.map(row=>({...row,id:n(row.id)})),Expenses:remote.Expenses.map(row=>({...row,id:n(row.id)}))}); await writeSheets(cfg,localRows(db)); }
  return {enabled:true};
}

async function save(db) { const cfg=config(); if(cfg) await writeSheets(cfg,localRows(db)); }

module.exports={initialize,save};
