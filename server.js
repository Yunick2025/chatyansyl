const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');

// Permet au serveur de lire ton image de fond et les fichiers du dossier
app.use(express.static(__dirname));

const USERS_FILE = './users.json';
const MSGS_FILE = './messages.json';

// Initialisation des fichiers s'ils n'existent pas
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(MSGS_FILE)) fs.writeFileSync(MSGS_FILE, '[]');

let registeredUsers = JSON.parse(fs.readFileSync(USERS_FILE));
let messagesHistory = JSON.parse(fs.readFileSync(MSGS_FILE));
let onlineUsers = {}; // Stocke { "Pseudo": "SocketID" }

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    let currentUser = "";

    // --- INSCRIPTION ---
    socket.on('register', (data) => {
        if (registeredUsers.find(u => u.pseudo === data.pseudo)) {
            socket.emit('auth-error', 'Ce pseudo est déjà utilisé.');
        } else {
            const newUser = { 
                pseudo: data.pseudo, 
                password: data.password, 
                joinedAt: Date.now() 
            };
            registeredUsers.push(newUser);
            fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers));
            socket.emit('auth-success', data.pseudo);
            console.log("Nouveau compte : " + data.pseudo);
        }
    });

    // --- CONNEXION ---
    socket.on('login', (data) => {
        const user = registeredUsers.find(u => u.pseudo === data.pseudo && u.password === data.password);
        if (user) {
            currentUser = data.pseudo;
            onlineUsers[currentUser] = socket.id; // On enregistre l'ID de connexion
            
            socket.emit('auth-success', currentUser);
            socket.emit('load-history', messagesHistory);

            // ON ENVOIE LA LISTE MISE À JOUR À TOUT LE MONDE
            io.emit('update-users', Object.keys(onlineUsers));
            console.log(currentUser + " est en ligne");
        } else {
            socket.emit('auth-error', 'Pseudo ou mot de passe incorrect.');
        }
    });

    // --- CHAT GÉNÉRAL ---
    socket.on('chat message', (data) => {
        const msg = { from: data.user, to: 'all', text: data.text, date: Date.now() };
        messagesHistory.push(msg);
        fs.writeFileSync(MSGS_FILE, JSON.stringify(messagesHistory));
        io.emit('chat message', msg);
    });

    // --- CHAT PRIVÉ ---
    socket.on('private-msg', (data) => {
        const msg = { from: currentUser, to: data.to, text: data.text, date: Date.now() };
        messagesHistory.push(msg);
        fs.writeFileSync(MSGS_FILE, JSON.stringify(messagesHistory));
        
        const targetId = onlineUsers[data.to];
        if (targetId) {
            io.to(targetId).emit('private-msg', msg);
        }
    });

    // --- INFOS PROFIL (CLIC DROIT) ---
    socket.on('get-user-info', (targetPseudo) => {
        const user = registeredUsers.find(u => u.pseudo === targetPseudo);
        if (user) {
            socket.emit('user-info-result', {
                pseudo: user.pseudo,
                joinedAt: user.joinedAt
            });
        }
    });

    // --- DÉCONNEXION ---
    socket.on('disconnect', () => {
        if (currentUser) {
            delete onlineUsers[currentUser];
            io.emit('update-users', Object.keys(onlineUsers));
            console.log(currentUser + " est parti");
        }
    });
});

// --- CONFIGURATION DU PORT POUR INTERNET ---
// On utilise process.env.PORT pour que l'hébergeur puisse choisir son port
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log("Serveur démarré sur le port : " + PORT);
});