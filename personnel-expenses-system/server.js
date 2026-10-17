const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'personnel-expenses.sqlite'));
db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
 display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS personnel (
 id INTEGER PRIMARY KEY, employee_no TEXT NOT NULL UNIQUE, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
 department TEXT NOT NULL DEFAULT '', job_title TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Inactive')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expenses (
 id INTEGER PRIMARY KEY, personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE RESTRICT,
 expense_date TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Rejected','Paid')),
 created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS expenses_person_idx ON expenses(personnel_id);`);

const sessions = new Map();
const scrypt = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const validPassword = p => typeof p === 'string' && p.length >= 10 && p.length <= 200;
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const publicUser = u => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role === 'admin' ? 'admin' : 'user' });
const json = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
const readBody = req => new Promise((resolve, reject) => {
 let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) req.destroy(); });
 req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON body')); } }); req.on('error', reject);
});
const text = (v, label, max = 120) => { if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new Error(`${label} is required (maximum ${max} characters).`); return v.trim(); };
const moneyCents = v => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 100000000) throw new Error('Amount must be greater than zero and no more than 100,000,000.'); return Math.round(n * 100); };
const asPerson = p => ({ employeeNo: p.employee_no, firstName: p.first_name, lastName: p.last_name, department: p.department, jobTitle: p.job_title, email: p.email, status: p.status, createdAt: p.created_at });
const asExpense = e => ({ id: e.id, personnelId: e.personnel_id, employeeName: `${e.first_name} ${e.last_name}`, employeeNo: e.employee_no, expenseDate: e.expense_date, category: e.category, description: e.description, amount: e.amount_cents / 100, status: e.status, createdBy: e.created_by_name || '' });
const expenseQuery = `SELECT e.*, p.first_name,p.last_name,p.employee_no,u.display_name AS created_by_name FROM expenses e JOIN personnel p ON p.id=e.personnel_id LEFT JOIN users u ON u.id=e.created_by`;
const route = async (req, res) => {
 const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const p = url.pathname;
 if (p.startsWith('/api/')) {
  if (req.method === 'GET' && p === '/api/setup-status') return json(res, 200, { setupRequired: userCount() === 0 });
  if (req.method === 'POST' && p === '/api/setup') {
   const b = await readBody(req); if (userCount() !== 0) return json(res, 409, { error: 'Initial setup has already been completed.' });
   const username = text(b.username, 'Username', 40).toLowerCase(); const displayName = text(b.displayName, 'Name', 100);
   if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Username must be 3–40 characters: letters, numbers, dots, underscores, or hyphens.');
   if (!validPassword(b.password)) throw new Error('Password must be between 10 and 200 characters.');
   const salt = crypto.randomBytes(16).toString('hex'); const result = db.prepare('INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,?,?)').run(username, displayName, `${salt}:${scrypt(b.password,salt)}`, 'admin');
   const u = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid); return issueSession(res, u);
  }
  if (req.method === 'POST' && p === '/api/login') {
   const b = await readBody(req); const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username || ''));
   if (!u || !validPassword(b.password)) return json(res, 401, { error: 'Username or password is incorrect.' });
   const [salt, hash] = u.password_hash.split(':'); const actual = Buffer.from(scrypt(b.password,salt),'hex'); const expected = Buffer.from(hash,'hex');
   if (actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected)) return json(res, 401, { error: 'Username or password is incorrect.' });
   return issueSession(res,u);
  }
  const token = (req.headers.cookie || '').match(/(?:^|;\s*)pes_session=([a-f0-9]+)/)?.[1];
  const session = token && sessions.get(token); const user = session && session.expires > Date.now() ? db.prepare('SELECT * FROM users WHERE id=?').get(session.userId) : null;
  if (session && !user) sessions.delete(token);
  const needAuth = () => { if (!user) { json(res,401,{error:'Please sign in.'}); return false; } return true; };
  if (req.method === 'GET' && p === '/api/me') return user ? json(res,200,{user:publicUser(user),setupRequired:false}) : json(res,200,{user:null,setupRequired:userCount()===0});
  if (req.method === 'POST' && p === '/api/logout') { if (token) sessions.delete(token); res.writeHead(204,{'Set-Cookie':'pes_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'}); return res.end(); }
  if (!needAuth()) return;
  const adminOnly = () => { if (user.role !== 'admin') { json(res,403,{error:'Administrator access is required.'}); return false; } return true; };
  if (req.method === 'GET' && p === '/api/dashboard') {
   const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : new Date().toISOString().slice(0,7);
   const sums = db.prepare(`SELECT status,COUNT(*) AS count,COALESCE(SUM(amount_cents),0) AS total FROM expenses WHERE substr(expense_date,1,7)=? GROUP BY status`).all(month);
   const totals = Object.fromEntries(['Pending','Approved','Rejected','Paid'].map(s => [s,{count:0,total:0}])); for (const r of sums) totals[r.status]={count:r.count,total:r.total/100};
   return json(res,200,{month,personnelCount:db.prepare("SELECT COUNT(*) AS n FROM personnel WHERE status='Active'").get().n,expenseCount:db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE substr(expense_date,1,7)=?").get(month).n,totals});
  }
  if (req.method === 'GET' && p === '/api/personnel') {
   const search = `%${(url.searchParams.get('q') || '').slice(0,100)}%`;
   const rows = db.prepare('SELECT * FROM personnel WHERE employee_no LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR department LIKE ? ORDER BY last_name,first_name').all(search,search,search,search);
   return json(res,200,rows.map(r=>({id:r.id,...asPerson(r)})));
  }
  if (req.method === 'POST' && p === '/api/personnel') {
   if(!adminOnly()) return;
   const b=await readBody(req); const fields=[text(b.employeeNo,'Employee number',40),text(b.firstName,'First name',80),text(b.lastName,'Last name',80),String(b.department||'').trim().slice(0,100),String(b.jobTitle||'').trim().slice(0,100),String(b.email||'').trim().slice(0,160)];
   if(fields[5] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields[5])) throw new Error('Enter a valid email address.');
   const r=db.prepare('INSERT INTO personnel(employee_no,first_name,last_name,department,job_title,email) VALUES(?,?,?,?,?,?)').run(...fields); return json(res,201,{id:r.lastInsertRowid});
  }
  const personId=p.match(/^\/api\/personnel\/(\d+)$/);
  if (req.method === 'PUT' && personId) { const b=await readBody(req); const fields=[text(b.employeeNo,'Employee number',40),text(b.firstName,'First name',80),text(b.lastName,'Last name',80),String(b.department||'').trim().slice(0,100),String(b.jobTitle||'').trim().slice(0,100),String(b.email||'').trim().slice(0,160)]; if(!['Active','Inactive'].includes(b.status)) throw new Error('Choose Active or Inactive status.'); const r=db.prepare('UPDATE personnel SET employee_no=?,first_name=?,last_name=?,department=?,job_title=?,email=?,status=? WHERE id=?').run(...fields,b.status,Number(personId[1])); if(!r.changes)return json(res,404,{error:'Personnel record not found.'}); return json(res,200,{ok:true}); }
  if (req.method === 'GET' && p === '/api/expenses') { const rows=db.prepare(`${expenseQuery} ORDER BY e.expense_date DESC,e.id DESC`).all(); return json(res,200,rows.map(asExpense)); }
  if (req.method === 'POST' && p === '/api/expenses') { const b=await readBody(req); const pid=Number(b.personnelId); if(!Number.isInteger(pid)||!db.prepare('SELECT id FROM personnel WHERE id=?').get(pid)) throw new Error('Select a valid personnel record.'); if(!/^\d{4}-\d{2}-\d{2}$/.test(b.expenseDate)||Number.isNaN(Date.parse(`${b.expenseDate}T00:00:00Z`))) throw new Error('Enter a valid expense date.'); const category=text(b.category,'Category',60); const description=String(b.description||'').trim().slice(0,500); const cents=moneyCents(b.amount); const r=db.prepare('INSERT INTO expenses(personnel_id,expense_date,category,description,amount_cents,created_by) VALUES(?,?,?,?,?,?)').run(pid,b.expenseDate,category,description,cents,user.id); const e=db.prepare(`${expenseQuery} WHERE e.id=?`).get(r.lastInsertRowid); return json(res,201,asExpense(e)); }
  const expenseId=p.match(/^\/api\/expenses\/(\d+)$/);
  if (req.method === 'PATCH' && expenseId) { const b=await readBody(req); if(!['Pending','Approved','Rejected','Paid'].includes(b.status))throw new Error('Choose a valid expense status.'); const r=db.prepare('UPDATE expenses SET status=? WHERE id=?').run(b.status,Number(expenseId[1])); if(!r.changes)return json(res,404,{error:'Expense record not found.'}); return json(res,200,{ok:true}); }
  if (req.method === 'GET' && p === '/api/users') { if(!adminOnly())return; return json(res,200,db.prepare('SELECT id,username,display_name,role,created_at FROM users ORDER BY display_name').all().map(u=>({id:u.id,username:u.username,displayName:u.display_name,role:u.role==='admin'?'admin':'user',createdAt:u.created_at}))); }
  if (req.method === 'POST' && p === '/api/users') { if(!adminOnly())return; const b=await readBody(req); const username=text(b.username,'Username',40).toLowerCase(); const displayName=text(b.displayName,'Name',100); if(!/^[a-z0-9._-]{3,40}$/.test(username))throw new Error('Use 3–40 letters, numbers, dots, underscores, or hyphens for username.'); if(!validPassword(b.password))throw new Error('Password must be between 10 and 200 characters.'); if(!['admin','user'].includes(b.role))throw new Error('Choose Administrator or User role.'); const salt=crypto.randomBytes(16).toString('hex'); const storedRole=b.role==='admin'?'admin':'staff'; const r=db.prepare('INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,?,?)').run(username,displayName,`${salt}:${scrypt(b.password,salt)}`,storedRole); return json(res,201,{id:r.lastInsertRowid}); }
  if (req.method === 'GET' && p === '/api/export.csv') { const rows=db.prepare(`${expenseQuery} ORDER BY e.expense_date DESC,e.id DESC`).all(); const cell=v=>`"${String(v??'').replaceAll('"','""')}"`; const csv=[['Date','Employee No.','Employee','Department','Category','Description','Amount','Status'],...rows.map(e=>[e.expense_date,e.employee_no,`${e.first_name} ${e.last_name}`,db.prepare('SELECT department FROM personnel WHERE id=?').get(e.personnel_id).department,e.category,e.description,(e.amount_cents/100).toFixed(2),e.status])].map(r=>r.map(cell).join(',')).join('\r\n'); res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="personnel-expenses.csv"','Cache-Control':'no-store'});return res.end('\uFEFF'+csv); }
  return json(res,404,{error:'API route not found.'});
 }
 const file = p === '/' ? '/index.html' : p; const target = path.resolve(__dirname,'public',`.${decodeURIComponent(file)}`); const root=path.resolve(__dirname,'public');
 if (!target.startsWith(root+path.sep)) return json(res,403,{error:'Forbidden.'});
 fs.readFile(target,(err,data)=>{ if(err){res.writeHead(404);return res.end('Not found');} const ext=path.extname(target); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'}; res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(data); });
};
function issueSession(res,u){const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{userId:u.id,expires:Date.now()+8*60*60*1000});res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Set-Cookie':`pes_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`});res.end(JSON.stringify({user:publicUser(u)}));}
const server=http.createServer((req,res)=>{Promise.resolve(route(req,res)).catch(err=>{const msg=String(err.message||'Request failed');const code=msg.includes('UNIQUE constraint failed')?409:400;json(res,code,{error:code===409?'That username or employee number is already in use.':msg});});});
server.listen(PORT,"0.0.0.0",()=>console.log(`Server running on port ${PORT}`));
