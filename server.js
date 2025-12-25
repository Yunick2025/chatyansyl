const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, { maxHttpBufferSize: 5e7 });
const fs = require('fs');
const bcrypt = require('bcryptjs');

app.use(express.static(__dirname));

const USERS_FILE = './users.json';
const MSGS_FILE = './messages.json';

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(MSGS_FILE)) fs.writeFileSync(MSGS_FILE, '[]');

let registeredUsers = JSON.parse(fs.readFileSync(USERS_FILE));
let messagesHistory = JSON.parse(fs.readFileSync(MSGS_FILE));
let onlineUsers = {};

// MIGRATION AUTO (Ajout du champ 'unread')
registeredUsers = registeredUsers.map(u => {
    if (!u.settings) u.settings = { chatBg: "", colorMe: "#ff7b00", colorOther: "rgba(255,255,255,0.1)", theme: "dark", opacity: "0.4" };
    if (!u.unread) u.unread = {}; // Stocke: { "Pierre": 2, "Paul": 5 }
    if (!u.status) u.status = "Salut !"; 
    if (!u.banned) u.banned = false;
    if (!u.avatar) u.avatar = "";
    if (!u.friends) u.friends = [];
    if (!u.requests) u.requests = [];
    if (!u.blocked) u.blocked = [];
    return u;
});
fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers));

function escapeHtml(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    let currentUser = "";

    socket.on('register', async (data) => {
        if (registeredUsers.find(u => u.pseudo === data.pseudo)) {
            socket.emit('auth-error', 'Pseudo déjà pris');
        } else {
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash(data.password, salt);
            const newUser = { 
                pseudo: data.pseudo, password: hash, joinedAt: Date.now(),
                age: data.age, sex: data.sex, avatar: data.avatar, status: "Salut !",
                friends: [], requests: [], blocked: [], banned: false, unread: {},
                settings: { chatBg: "", colorMe: "#ff7b00", colorOther: "rgba(255,255,255,0.1)", theme: "dark", opacity: "0.9" }
            };
            registeredUsers.push(newUser);
            fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers));
            socket.emit('auth-success', { pseudo: data.pseudo, avatar: data.avatar, settings: newUser.settings, isAdmin: false });
        }
    });

    socket.on('login', async (data) => {
        const user = registeredUsers.find(u => u.pseudo === data.pseudo);
        if (user && await bcrypt.compare(data.password, user.password)) {
            if(user.banned) { socket.emit('auth-error', 'Compte banni.'); return; }
            currentUser = data.pseudo;
            onlineUsers[currentUser] = socket.id;
            const isAdmin = (currentUser === "Admin");

            socket.emit('auth-success', { pseudo: currentUser, avatar: user.avatar, status: user.status, settings: user.settings, isAdmin: isAdmin });
            socket.emit('load-history', messagesHistory);
            io.emit('update-users', Object.keys(onlineUsers));
            socket.emit('update-friends', { friends: user.friends, requests: user.requests });
            io.emit('update-statuses', getStatuses());
            
            // ENVOYER LES NOTIFICATIONS NON LUES
            socket.emit('update-unread', user.unread || {});
            
            sendAvatarsMap();
        } else {
            socket.emit('auth-error', 'Identifiants incorrects');
        }
    });

    // MARQUER COMME LU (Remet le compteur à 0)
    socket.on('mark-read', (senderPseudo) => {
        const user = registeredUsers.find(u => u.pseudo === currentUser);
        if(user && user.unread && user.unread[senderPseudo]) {
            delete user.unread[senderPseudo]; // On supprime le compteur
            fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers));
            socket.emit('update-unread', user.unread);
        }
    });

    // PRIVÉ (Avec incrémentation du compteur)
    socket.on('private-msg', (data) => {
        if(!currentUser) return;
        const targetUser = registeredUsers.find(u => u.pseudo === data.to);
        if (targetUser && targetUser.blocked.includes(currentUser)) return;

        let content = "";
        if(data.type === 'audio') content = data.audioData;
        else if(data.type === 'image') content = data.image;
        else content = escapeHtml(data.text);

        const msg = { type: data.type || 'text', from: currentUser, to: data.to, content: content, date: Date.now() };
        messagesHistory.push(msg);
        fs.writeFileSync(MSGS_FILE, JSON.stringify(messagesHistory));
        
        // GESTION COMPTEUR NON LU
        if(targetUser) {
            if(!targetUser.unread) targetUser.unread = {};
            if(!targetUser.unread[currentUser]) targetUser.unread[currentUser] = 0;
            targetUser.unread[currentUser]++;
            fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers));
            
            // Si connecté, on met à jour son compteur en direct
            const targetId = onlineUsers[data.to];
            if (targetId) {
                io.to(targetId).emit('private-msg', msg);
                io.to(targetId).emit('update-unread', targetUser.unread);
            }
        }
    });

    // ... (Le reste du code standard) ...
    socket.on('save-settings', (ns) => { const u=registeredUsers.find(x=>x.pseudo===currentUser); if(u){ u.settings={chatBg:(ns.chatBg==="DEFAULT")?"":(ns.chatBg||u.settings.chatBg), colorMe:ns.colorMe||u.settings.colorMe, colorOther:ns.colorOther||u.settings.colorOther, theme:ns.theme||u.settings.theme, opacity:ns.opacity||u.settings.opacity}; fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers)); socket.emit('notification', "Préférences sauvegardées !"); } });
    socket.on('update-profile', async (d) => { const u=registeredUsers.find(x=>x.pseudo===currentUser); if(u){ if(d.avatar)u.avatar=d.avatar; if(d.status)u.status=escapeHtml(d.status).substring(0,50); if(d.password&&d.password.trim()!==""){ const s=await bcrypt.genSalt(10); u.password=await bcrypt.hash(d.password,s); } fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers)); socket.emit('profile-updated', "Profil mis à jour !"); io.emit('update-statuses', getStatuses()); sendAvatarsMap(); } });
    function getStatuses() { let s={}; registeredUsers.forEach(u=>s[u.pseudo]=u.status); return s; }
    function sendAvatarsMap() { let m={}; registeredUsers.forEach(u=>m[u.pseudo]=u.avatar); io.emit('update-avatars', m); }
    socket.on('chat message', (d) => { if(!currentUser)return; const id=Date.now()+Math.random().toString(36).substr(2,9); let c=d.type==='image'?d.image:escapeHtml(d.text); const m={id:id, type:d.type||'text', from:d.user, to:'all', content:c, date:Date.now()}; messagesHistory.push(m); if(messagesHistory.length>200)messagesHistory.shift(); fs.writeFileSync(MSGS_FILE, JSON.stringify(messagesHistory)); io.emit('chat message', m); });
    socket.on('admin-delete-msg', (id) => { if(currentUser!=="Admin")return; messagesHistory=messagesHistory.filter(m=>m.id!==id); fs.writeFileSync(MSGS_FILE, JSON.stringify(messagesHistory)); io.emit('load-history', messagesHistory); });
    socket.on('admin-ban-user', (p) => { if(currentUser!=="Admin")return; const u=registeredUsers.find(x=>x.pseudo===p); if(u){ u.banned=true; fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers)); const s=onlineUsers[p]; if(s){ io.to(s).emit('force-disconnect'); io.sockets.sockets.get(s)?.disconnect(true); } io.emit('notification', `User ${p} banned.`); } });
    socket.on('get-user-info', (p) => { const u=registeredUsers.find(x=>x.pseudo===p), m=registeredUsers.find(x=>x.pseudo===currentUser); if(u&&m) socket.emit('user-info-result', { pseudo:u.pseudo, joinedAt:u.joinedAt, age:u.age, sex:u.sex, avatar:u.avatar, status:u.status, isFriend:m.friends.includes(p), requestSent:u.requests.includes(currentUser), isBlocked:m.blocked.includes(p) }); });
    socket.on('send-friend-request', (p) => { const t=registeredUsers.find(x=>x.pseudo===p), m=registeredUsers.find(x=>x.pseudo===currentUser); if(t&&m&&!t.blocked.includes(currentUser)&&!t.requests.includes(currentUser)&&!t.friends.includes(currentUser)){ t.requests.push(currentUser); fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers)); const s=onlineUsers[p]; if(s){ io.to(s).emit('update-friends', {friends:t.friends, requests:t.requests}); io.to(s).emit('notification', `Demande de ${currentUser}`); } } });
    socket.on('respond-friend-request', (d) => { const m=registeredUsers.find(x=>x.pseudo===currentUser), s=registeredUsers.find(x=>x.pseudo===d.pseudo); if(m){ m.requests=m.requests.filter(r=>r!==d.pseudo); if(d.accept&&s){ if(!m.friends.includes(d.pseudo))m.friends.push(d.pseudo); if(!s.friends.includes(currentUser))s.friends.push(currentUser); } fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers)); socket.emit('update-friends', {friends:m.friends, requests:m.requests}); if(s&&onlineUsers[d.pseudo]) io.to(onlineUsers[d.pseudo]).emit('update-friends', {friends:s.friends, requests:s.requests}); } });
    socket.on('remove-friend', (p) => { const m=registeredUsers.find(x=>x.pseudo===currentUser), o=registeredUsers.find(x=>x.pseudo===p); if(m)m.friends=m.friends.filter(f=>f!==p); if(o)o.friends=o.friends.filter(f=>f!==currentUser); fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers)); socket.emit('update-friends', {friends:m.friends, requests:m.requests}); if(o&&onlineUsers[p]) io.to(onlineUsers[p]).emit('update-friends', {friends:o.friends, requests:o.requests}); });
    socket.on('block-user', (p) => { const m=registeredUsers.find(x=>x.pseudo===currentUser), o=registeredUsers.find(x=>x.pseudo===p); if(m&&!m.blocked.includes(p)){ m.blocked.push(p); m.friends=m.friends.filter(f=>f!==p); if(o)o.friends=o.friends.filter(f=>f!==currentUser); fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers)); socket.emit('update-friends', {friends:m.friends, requests:m.requests}); if(o&&onlineUsers[p]) io.to(onlineUsers[p]).emit('update-friends', {friends:o.friends, requests:o.requests}); } });
    socket.on('unblock-user', (p) => { const m=registeredUsers.find(x=>x.pseudo===currentUser); if(m){ m.blocked=m.blocked.filter(b=>b!==p); fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers)); socket.emit('notification', `Débloqué: ${p}`); } });
    socket.on('call-user', (d) => { const t=registeredUsers.find(x=>x.pseudo===d.to); if(t&&t.blocked.includes(currentUser))return; const s=onlineUsers[d.to]; if(s) io.to(s).emit('call-made', {offer:d.offer, socket:socket.id, from:currentUser}); });
    socket.on('make-answer', (d) => { io.to(d.to).emit('answer-made', {socket:socket.id, answer:data.answer}); });
    socket.on('ice-candidate', (d) => { io.to(d.to).emit('ice-candidate', {candidate:d.candidate}); });
    socket.on('hang-up', (d) => { const t=onlineUsers[data.to]; if(t) io.to(t).emit('hang-up'); });
    socket.on('disconnect', () => { if (currentUser) { delete onlineUsers[currentUser]; io.emit('update-users', Object.keys(onlineUsers)); } });
});

const PORT = 3000;
http.listen(PORT, () => { console.log("Serveur ULTIME V6 prêt sur port " + PORT); });