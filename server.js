const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const bcrypt = require('bcryptjs'); // L'outil de sécurité

app.use(express.static(__dirname));

const USERS_FILE = './users.json';
const MSGS_FILE = './messages.json';

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(MSGS_FILE)) fs.writeFileSync(MSGS_FILE, '[]');

let registeredUsers = JSON.parse(fs.readFileSync(USERS_FILE));
let messagesHistory = JSON.parse(fs.readFileSync(MSGS_FILE));
let onlineUsers = {};

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
    let currentUser = "";

    // --- INSCRIPTION (SÉCURISÉE) ---
    socket.on('register', async (data) => {
        if (registeredUsers.find(u => u.pseudo === data.pseudo)) {
            socket.emit('auth-error', 'Pseudo déjà pris');
        } else {
            // ON HACHE LE MOT DE PASSE (On le rend illisible)
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(data.password, salt);

            const newUser = { 
                pseudo: data.pseudo, 
                password: hashedPassword, // On enregistre la version codée
                joinedAt: Date.now() 
            };
            registeredUsers.push(newUser);
            fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers));
            socket.emit('auth-success', data.pseudo);
        }
    });

    // --- CONNEXION (SÉCURISÉE) ---
    socket.on('login', async (data) => {
        const user = registeredUsers.find(u => u.pseudo === data.pseudo);
        
        if (user) {
            // On compare le mot de passe tapé avec la version hachée
            const isMatch = await bcrypt.compare(data.password, user.password);
            
            if (isMatch) {
                currentUser = data.pseudo;
                onlineUsers[currentUser] = socket.id;
                socket.emit('auth-success', currentUser);
                socket.emit('load-history', messagesHistory);
                io.emit('update-users', Object.keys(onlineUsers));
            } else {
                socket.emit('auth-error', 'Mot de passe incorrect.');
            }
        } else {
            socket.emit('auth-error', 'Utilisateur non trouvé.');
        }
    });

    // --- LE RESTE DU CODE (Messages, etc.) ---
    socket.on('chat message', (data) => {
        const msg = { from: data.user, to: 'all', text: data.text, date: Date.now() };
        messagesHistory.push(msg);
        fs.writeFileSync(MSGS_FILE, JSON.stringify(messagesHistory));
        io.emit('chat message', msg);
    });

    socket.on('private-msg', (data) => {
        const msg = { from: currentUser, to: data.to, text: data.text, date: Date.now() };
        messagesHistory.push(msg);
        fs.writeFileSync(MSGS_FILE, JSON.stringify(messagesHistory));
        const targetId = onlineUsers[data.to];
        if (targetId) io.to(targetId).emit('private-msg', msg);
    });

    socket.on('get-user-info', (targetPseudo) => {
        const user = registeredUsers.find(u => u.pseudo === targetPseudo);
        if (user) socket.emit('user-info-result', { pseudo: user.pseudo, joinedAt: user.joinedAt });
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            delete onlineUsers[currentUser];
            io.emit('update-users', Object.keys(onlineUsers));
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log("Serveur sécurisé sur port " + PORT); });