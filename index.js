/**
 * Friend Quiz Online - Supabase Realtime Edition
 */

let supabaseClient = null;
const SUPABASE_URL = "https://sywueeqbijwdjjleyzbo.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5d3VlZXFiaWp3ZGpqbGV5emJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg2NTYwMTksImV4cCI6MjA4NDIzMjAxOX0.LtUDmZ5MIxTAuf8L9TZFvYKo8HY6TngiJyVRouln85Q";

let game = {
    // Usamos sessionStorage para permitir abrir várias abas no mesmo PC para testes
    playerId: sessionStorage.getItem('fq_playerId') || Math.random().toString(36).substr(2, 9),
    playerName: localStorage.getItem('fq_playerName'),
    roomCode: null,
    isHost: false,
    state: null,
    subscription: null,
    localSelection: null, // Armazena a seleção da rodada atual para destaque visual
    questions: [
        { id: 1, text: "Qual minha comida favorita?", icon: "utensils", placeholders: ["Pizza", "Churrasco", "Sushi", "Hambúrguer"] },
        { id: 2, text: "Qual meu hobby preferido?", icon: "gamepad", placeholders: ["Games", "Ler", "Academia", "Viajar"] },
        { id: 3, text: "Qual meu destino de sonho?", icon: "plane", placeholders: ["Japão", "Maldivas", "Suíça", "Disney"] },
        { id: 4, text: "Qual meu maior medo?", icon: "ghost", placeholders: ["Altura", "Aranhas", "Escuro", "Fracasso"] },
        { id: 5, text: "Gênero musical favorito?", icon: "music", placeholders: ["Rock", "Pop", "Sertanejo", "Funk"] }
    ],
    chat: {
        isOpen: false,
        unreadCount: 0,
        replyingTo: null // { name: string, text: string }
    }
};

sessionStorage.setItem('fq_playerId', game.playerId);

// --- INICIALIZAÇÃO ---

async function initSupabase() {
    try {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        
        // Pula diretamente para a home do jogo
        document.getElementById('setup-screen').classList.add('hidden_manual'); // Garante que a tela de setup suma
        document.getElementById('home-screen').classList.remove('hidden-screen');
    } catch (e) {
        console.error("Erro ao conectar ao Supabase:", e.message);
    }
}

// Inicializar automaticamente ao carregar
window.addEventListener('DOMContentLoaded', initSupabase);

async function syncPlayerRemoval(playerId) {
    if (!game.roomCode) return;

    const { data: room } = await supabaseClient
        .from('rooms')
        .select('data')
        .eq('code', game.roomCode)
        .single();

    if (room && room.data && room.data.players[playerId]) {
        const newData = { ...room.data };
        delete newData.players[playerId];

        const remainingPlayers = Object.keys(newData.players).length;
        if (remainingPlayers === 0) {
            await supabaseClient.from('rooms').delete().eq('code', game.roomCode);
        } else {
            if (newData.hostId === playerId) {
                newData.hostId = Object.keys(newData.players)[0];
            }
            await supabaseClient.from('rooms').update({ data: newData }).eq('code', game.roomCode);
        }
    }
}

// Lógica de saída persistente
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && game.roomCode) {
        // Tentativa de saída rápida
        const body = JSON.stringify({ playerId: game.playerId, roomCode: game.roomCode });
        // Infelizmente Supabase via Fetch é difícil no unload, por isso usamos Presence acima
    }
});

// --- COMANDOS DE SALA ---

async function uiCreateRoom() {
    const nameInput = document.getElementById('user-name-input');
    const name = nameInput.value.trim();
    if (!name) {
        alert("Por favor, digite seu nome primeiro!");
        nameInput.focus();
        return;
    }
    
    game.playerName = name;
    localStorage.setItem('fq_playerName', name);
    game.isHost = true;
    game.roomCode = Math.floor(100000 + Math.random() * 900000).toString();

    const initialData = {
        status: 'LOBBY',
        hostId: game.playerId,
        currentQuestionIndex: 0,
        subjectIndex: 0,
        guesses: [], // Armazena {subjectName, questionText, guesserName, selectedOption, correctOption, isCorrect}
        players: {
            [game.playerId]: { name, score: 0, answers: {}, ready: false }
        }
    };

    const { error } = await supabaseClient
        .from('rooms')
        .insert([{ code: game.roomCode, data: initialData }]);

    if (error) {
        alert("Erro ao criar sala: " + error.message);
        return;
    }

    startRoomSubscription();
}

async function uiJoinRoom(code) {
    const nameInput = document.getElementById('user-name-input');
    const name = nameInput.value.trim();
    
    if (!name) {
        alert("Por favor, digite seu nome primeiro!");
        nameInput.focus();
        return;
    }

    game.playerName = name;
    localStorage.setItem('fq_playerName', name);
    game.roomCode = code;
    game.isHost = false;

    const { data: room, error } = await supabaseClient
        .from('rooms')
        .select('*')
        .eq('code', code)
        .single();

    if (error || !room) {
        alert("Sala não encontrada ou já encerrada!");
        return;
    }

    // Buscamos os dados da sala NOVAMENTE logo antes de salvar para garantir que não vamos apagar outros que entraram
    const { data: latestRoom } = await supabaseClient
        .from('rooms')
        .select('data')
        .eq('code', code)
        .single();

    const roomData = latestRoom.data;
    roomData.players[game.playerId] = { name, score: 0, answers: {}, ready: false };

    await supabaseClient
        .from('rooms')
        .update({ data: roomData })
        .eq('code', code);

    startRoomSubscription();
}

async function refreshRooms() {
    const listContainer = document.getElementById('available-rooms-list');
    listContainer.innerHTML = '<p class="text-center text-gray-500 animate-pulse">Buscando salas...</p>';

    const { data: rooms, error } = await supabaseClient
        .from('rooms')
        .select('code, data')
        .eq('data->>status', 'LOBBY'); // Apenas salas que ainda não começaram

    if (error) {
        listContainer.innerHTML = '<p class="text-center text-red-400 text-xs">Erro ao carregar salas.</p>';
        return;
    }

    if (!rooms || rooms.length === 0) {
        listContainer.innerHTML = '<p class="text-center text-gray-500 text-sm py-4">Nenhuma sala aberta no momento.</p>';
        return;
    }

    listContainer.innerHTML = rooms.map(room => {
        const playerNames = Object.values(room.data.players).map(p => p.name).join(', ');
        return `
            <button onclick="uiJoinRoom('${room.code}')" class="w-full text-left p-4 bg-white/5 border border-white/10 rounded-2xl hover:bg-google-blue/10 hover:border-google-blue/30 transition-all group">
                <div class="flex justify-between items-center mb-1">
                    <span class="font-bold text-google-blue text-lg">#${room.code}</span>
                    <i class="fas fa-chevron-right text-gray-600 group-hover:text-google-blue"></i>
                </div>
                <div class="text-xs text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap">
                    <i class="fas fa-users mr-1"></i> ${playerNames}
                </div>
            </button>
        `;
    }).join('');
}

// --- REALTIME ---

function startRoomSubscription() {
    // Definimos o canal
    const channelId = `room:${game.roomCode}`;
    
    game.subscription = supabaseClient.channel(channelId, {
        config: {
            broadcast: { self: false }
        }
    });

    // 1. Escutar Mudanças no Banco (Estado do Jogo)
    game.subscription.on('postgres_changes', { 
        event: 'UPDATE', 
        schema: 'public', 
        table: 'rooms', 
        filter: `code=eq.${game.roomCode}` 
    }, payload => {
        handleRoomUpdate(payload.new.data);
    });

    // 2. Escutar Mensagens de Chat (Broadcast)
    game.subscription.on('broadcast', { event: 'chat_message' }, ({ payload }) => {
        console.log("%c[Chat] Mensagem Recebida:", "color: #00ff00; font-weight: bold;", payload);
        if (payload.senderId !== game.playerId) {
            renderChatMessage(payload);
        }
    });

    // 3. Gerenciar Presença
    game.subscription.on('presence', { event: 'leave' }, ({ leftPresences }) => {
        leftPresences.forEach(p => {
            if (game.isHost) syncPlayerRemoval(p.userId);
        });
    });

    // 4. Ativar Inscrição
    game.subscription.subscribe(async (status) => {
        console.log(`%c[Realtime] Status: ${status}`, "color: #888;");
        if (status === 'SUBSCRIBED') {
            await game.subscription.track({
                userId: game.playerId,
                online_at: new Date().toISOString(),
            });
        }
    });

    window.chatChannel = game.subscription; 
    console.log(`%c[Chat] Ativado no canal: ${channelId}`, "color: #0088ff; font-weight: bold;");

    // Fetch inicial
    supabaseClient.from('rooms').select('data').eq('code', game.roomCode).single().then(({data}) => {
        handleRoomUpdate(data.data);
    });

    document.getElementById('home-screen').classList.add('hidden-screen');
    document.getElementById('lobby-screen').classList.remove('hidden-screen');
    document.getElementById('display-room-code').innerText = `#${game.roomCode}`;
}

function handleRoomUpdate(data) {
    game.state = data;
    const players = Object.values(data.players);

    // LOBBY
    if (data.status === 'LOBBY') {
        const lobbyContainer = document.getElementById('lobby-players');
        lobbyContainer.innerHTML = players.map(p => `
            <div class="player-chip">
                <i class="fas fa-user-circle text-google-blue"></i> ${p.name}
            </div>
        `).join('');

        if (game.isHost) {
            document.getElementById('host-controls').classList.toggle('hidden-screen', players.length < 2);
            document.getElementById('guest-msg').classList.add('hidden-screen');
        } else {
            document.getElementById('guest-msg').classList.remove('hidden-screen');
        }
    }

    // PHASE: ENTRY (Answers)
    if (data.status === 'ENTRY') {
        const myData = data.players[game.playerId];
        if (myData.ready) {
            showWaitScreen(players);
        } else {
            renderEntryScreen();
        }
    }

    // PHASE: QUIZ
    if (data.status === 'QUIZ') {
        document.getElementById('results-screen').classList.add('hidden-screen');
        renderQuizScreen(data);
    }

    // PHASE: REVEAL
    if (data.status === 'REVEAL') {
        renderRevealScreen(data);
    }

    // PHASE: RESULTS
    if (data.status === 'RESULTS') {
        showResults(players);
    }
}

// --- FASES DO JOGO ---

async function uiStartGame() {
    const newState = { ...game.state, status: 'ENTRY' };
    await updateRoomState(newState);
}

function renderEntryScreen() {
    document.getElementById('lobby-screen').classList.add('hidden-screen');
    document.getElementById('entry-screen').classList.remove('hidden-screen');

    const container = document.getElementById('entry-questions');
    container.innerHTML = game.questions.map(q => `
        <div class="space-y-4 mb-10 p-5 bg-white/5 rounded-3xl border border-white/5 shadow-inner">
            <div class="px-1 mb-2">
                <label class="text-xs font-bold text-google-blue uppercase flex items-center gap-2 mb-1">
                    <i class="fas fa-${q.icon}"></i> ${q.text}
                </label>
                <p class="text-[10px] text-gray-500 uppercase tracking-tighter">Escreva a resposta <span class="text-google-green font-bold text-xs">CORRETA</span> na primeira linha</p>
            </div>
            
            <div class="space-y-3" id="q-inputs-${q.id}">
                ${[0, 1, 2, 3].map(i => `
                    <div class="flex gap-2 items-center group">
                        <div class="relative flex-grow">
                            <input type="text" 
                                class="entry-text-input w-full bg-[#2b2930] border-b-2 border-white/10 rounded-t-xl px-4 py-3 text-sm focus:border-google-blue focus:bg-white/5 outline-none transition-all placeholder:italic placeholder:opacity-40"
                                placeholder="Ex: ${q.placeholders[i]}..."
                                value=""
                                data-q-id="${q.id}" data-idx="${i}">
                        </div>
                        <div class="min-w-[44px] h-[44px] flex items-center justify-center transition-all">
                            ${i === 0 ? `
                                <div class="w-8 h-8 rounded-full bg-google-green/10 border border-google-green text-google-green flex items-center justify-center shadow-lg shadow-google-green/5 animate-pulse" title="Sua resposta correta vai aqui">
                                    <i class="fas fa-check text-xs"></i>
                                </div>
                            ` : `
                                <div class="w-8 h-8 rounded-full border border-white/5 flex items-center justify-center text-gray-800">
                                    <i class="fas fa-minus text-[10px]"></i>
                                </div>
                            `}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
    
    // Forçar a primeira opção como a correta para todas as questões
    window.correctAnswers = {};
    game.questions.forEach(q => {
        window.correctAnswers[q.id] = 0;
    });
}

function setCorrectEntry(qId, idx) {
    // Resetar todos os botões daquela questão
    const container = document.getElementById(`q-inputs-${qId}`);
    container.querySelectorAll('.correct-selector-btn').forEach(btn => {
        btn.classList.remove('text-google-green', 'border-google-green', 'bg-google-green/10', 'scale-110');
        btn.classList.add('text-gray-500', 'border-white/10');
    });

    // Marcar o novo botão de forma mais leve (apenas cores e escala)
    const targetBtn = document.getElementById(`btn-correct-${qId}-${idx}`);
    targetBtn.classList.remove('text-gray-500', 'border-white/10');
    targetBtn.classList.add('text-google-green', 'border-google-green', 'bg-google-green/10', 'scale-110');

    window.correctAnswers[qId] = idx;
}

async function uiSubmitAnswers() {
    const questions = game.questions;
    const answers = {};
    let allValid = true;

    for (const q of questions) {
        const correctIdx = window.correctAnswers[q.id];
        const inputs = Array.from(document.querySelectorAll(`.entry-text-input[data-q-id="${q.id}"]`));
        const values = inputs.map(i => i.value.trim()).filter(v => v !== "");
        
        // Verifica se tem 4 preenchidos e um marcado como correto
        if (values.length !== 4 || correctIdx === null || inputs[correctIdx].value.trim() === "") {
            allValid = false;
            break;
        }

        const correctValue = inputs[correctIdx].value.trim();
        answers[q.id] = {
            correct: correctValue,
            options: shuffleArray(values)
        };
    }

    if (!allValid) {
        alert("Por favor, preencha as 4 opções e marque a correta em TODAS as perguntas!");
        return;
    }

    const newState = { ...game.state };
    newState.players[game.playerId].answers = answers;
    newState.players[game.playerId].ready = true;


    // Se sou o host e todos estão prontos, vai pro quiz
    const allReady = Object.values(newState.players).every(p => p.ready);
    if (allReady) {
        newState.status = 'QUIZ';
        newState.currentQuestionIndex = 0;
        newState.subjectIndex = 0;
        // Reinicia ready para usar no quiz se necessário ou apenas segue
    }

    await updateRoomState(newState);
}

function showWaitScreen(players) {
    document.getElementById('entry-screen').classList.add('hidden-screen');
    document.getElementById('lobby-screen').classList.remove('hidden-screen');
    document.getElementById('guest-msg').innerHTML = "Aguardando os outros amigos responderem...";
}

function renderQuizScreen(data) {
    document.getElementById('lobby-screen').classList.add('hidden-screen');
    document.getElementById('entry-screen').classList.add('hidden-screen');
    document.getElementById('quiz-screen').classList.remove('hidden-screen');

    const playerIds = Object.keys(data.players);
    const subjectId = playerIds[data.subjectIndex];
    const subject = data.players[subjectId];
    const question = game.questions[data.currentQuestionIndex % game.questions.length];

    document.getElementById('subject-name').innerText = subject.name;
    document.getElementById('question-text').innerText = question.text;
    document.getElementById('quiz-progress').innerText = `RODADA ${data.currentQuestionIndex + 1}`;

    const grid = document.getElementById('options-grid');
    
    if (game.playerId === subjectId) {
        document.getElementById('quiz-turn').innerText = "VOCÊ É O FOCO!";
        grid.innerHTML = `<div class="p-8 text-center text-gray-500 italic">Eles estão tentando adivinhar sua resposta...</div>`;
    } else {
        document.getElementById('quiz-turn').innerText = "SUA VEZ DE ADIVINHAR";
        
        const questionInfo = subject.answers[question.id];
        const correct = questionInfo.correct;
        const options = questionInfo.options;

        // Limpar a seleção local se a rodada mudou
        const currentRoundKey = `${data.subjectIndex}-${data.currentQuestionIndex}`;
        if (game.lastRoundKey !== currentRoundKey) {
            game.localSelection = null;
            game.lastRoundKey = currentRoundKey;
        }

        grid.innerHTML = options.map(opt => {
            const isSelected = game.localSelection === opt;
            return `
                <button onclick="handleGuess('${opt.replace(/'/g, "\\'")}', '${correct.replace(/'/g, "\\'")}')" 
                    ${game.localSelection ? 'disabled' : ''}
                    class="quiz-option-btn m3-btn-outline !text-left transition-all ${isSelected ? 'bg-google-blue border-google-blue text-black font-bold scale-[1.02]' : 'hover:bg-white/5'}">
                    ${opt}
                </button>
            `;
        }).join('');
    }
}

async function handleGuess(selected, correct) {
    const isCorrect = selected === correct;
    
    // Salvar seleção local para destaque visual imediato
    game.localSelection = selected;
    
    // Desabilitar botões visualmente
    document.querySelectorAll('.quiz-option-btn').forEach(btn => {
        btn.disabled = true;
        if (btn.innerText.trim() === selected) {
            btn.classList.add('bg-google-blue', 'border-google-blue', 'text-black', 'font-bold', 'scale-[1.02]');
            btn.classList.remove('hover:bg-white/5');
        }
    });
    
    // Atualizar pontuação silenciosamente no Supabase
    const latestSnap = await supabaseClient.from('rooms').select('data').eq('code', game.roomCode).single();
    if (!latestSnap.data) return;

    const newState = latestSnap.data.data;
    const playerIds = Object.keys(newState.players);
    const subjectId = playerIds[newState.subjectIndex];
    const subject = newState.players[subjectId];
    const question = game.questions[newState.currentQuestionIndex % game.questions.length];
    const questionInfo = subject.answers[question.id];
    const options = questionInfo.options; // Definindo options aqui

    if (isCorrect) {
        newState.players[game.playerId].score += 1;
    }

    // Registrar o palpite de forma mais estruturada
    if (!newState.guesses) newState.guesses = [];
    newState.guesses.push({
        subjectName: subject.name,
        questionText: question.text,
        guesserName: game.playerName,
        selectedOption: selected,
        correctOption: correct,
        allOptions: options, // Agora options está definida
        roundIndex: newState.currentQuestionIndex,
        subjectId: subjectId
    });

    // AVANÇAR: Verificar se todos os adivinhadores já votaram nesta rodada específica
    // (Adivinhadores = Todos menos o Subject)
    const totalVotersNeeded = playerIds.length - 1;
    const currentRoundGuesses = newState.guesses.filter(g => 
        g.roundIndex === newState.currentQuestionIndex && 
        g.subjectName === subject.name
    );

    if (currentRoundGuesses.length >= totalVotersNeeded) {
        // Se todos já votaram, agora sim avançamos
        let nextSub = newState.subjectIndex;
        let nextQ = newState.currentQuestionIndex + 1;

        if (nextQ >= game.questions.length) {
            newState.status = 'REVEAL'; 
        } else {
            newState.currentQuestionIndex = nextQ;
        }
    } else {
        // Ainda faltam votos, apenas atualizamos o estado com o seu voto registrado
        // handleRoomUpdate cuidará de manter os botões desabilitados via CSS ou JS
    }

    // Atualiza o estado global
    await updateRoomState(newState);
}

// advanceRound foi removido pois a lógica foi integrada ao handleGuess para evitar bugs de sincronização e delay


function renderRevealScreen(data) {
    document.getElementById('quiz-screen').classList.add('hidden-screen');
    const revealContainer = document.getElementById('results-screen');
    revealContainer.classList.remove('hidden-screen');
    revealContainer.classList.add('!max-w-3xl');

    const playerIds = Object.keys(data.players);
    const subjectId = playerIds[data.subjectIndex];
    const subject = data.players[subjectId];

    // Título da tela de revelação
    const rankingTitle = revealContainer.querySelector('.text-center.mb-8');
    rankingTitle.innerText = `REVELAÇÃO: ${subject.name}`;

    // Esconder o ranking original temporariamente (ou usar pra mostrar parciais)
    const rankingContainer = document.getElementById('ranking');
    rankingContainer.innerHTML = `<p class="text-center text-google-blue font-bold mb-4">Veja como seus amigos votaram nas suas perguntas!</p>`;

    // Filtrar apenas palpites deste round/jogador
    const roundGuesses = data.guesses.filter(g => g.subjectName === subject.name);
    const grouped = {};
    roundGuesses.forEach(g => {
        if (!grouped[g.questionText]) {
            grouped[g.questionText] = {
                text: g.questionText,
                options: g.allOptions,
                correct: g.correctOption,
                votes: []
            };
        }
        grouped[g.questionText].votes.push({ user: g.guesserName, choice: g.selectedOption });
    });

    const historySection = document.createElement('div');
    historySection.className = "mt-6 space-y-8 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar reveal-history";
    historySection.innerHTML = Object.values(grouped).map(q => `
        <div class="space-y-4 bg-white/5 p-6 rounded-3xl border border-white/5 shadow-xl">
            <h4 class="text-xl font-bold text-white mb-3">${q.text}</h4>
            <div class="grid gap-3">
                ${q.options.map(opt => {
                    const voters = q.votes.filter(v => v.choice === opt).map(v => v.user);
                    const isCorrect = opt === q.correct;
                    return `
                        <div class="p-4 rounded-xl border ${isCorrect ? 'border-google-green bg-google-green/10' : 'border-white/10 bg-white/5'}">
                            <div class="flex justify-between items-center mb-2">
                                <span class="text-lg ${isCorrect ? 'text-google-green font-bold' : 'text-white'}">${opt}</span>
                            </div>
                            <div class="flex flex-wrap gap-2">
                                ${voters.map(v => `<span class="text-sm px-3 py-1 rounded-full ${isCorrect ? 'bg-google-green/40 border border-google-green' : 'bg-white/10'} text-white font-bold">${v}</span>`).join('')}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `).join('');

    // Botão para continuar
    const nextBtn = document.createElement('button');
    nextBtn.className = "m3-btn-filled w-full mt-8 py-4 text-lg";
    nextBtn.innerText = game.isHost ? "Próximo Jogador" : "Aguardando Host...";
    if (!game.isHost) nextBtn.disabled = true;
    nextBtn.onclick = uiNextSubject;

    // Limpeza de componentes anteriores
    const oldHistory = revealContainer.querySelector('.reveal-history');
    if (oldHistory) oldHistory.remove();
    const oldBtn = revealContainer.querySelector('.m3-btn-outline');
    if (oldBtn) oldBtn.classList.add('hidden-screen');
    const oldNextBtn = revealContainer.querySelector('.m3-btn-filled:not(#host-controls button)');
    if (oldNextBtn) oldNextBtn.remove();

    revealContainer.appendChild(historySection);
    revealContainer.appendChild(nextBtn);
}

async function uiNextSubject() {
    const newState = { ...game.state };
    newState.subjectIndex++;
    newState.currentQuestionIndex = 0;
    
    // Se todos terminaram, vai pro ranking final
    if (newState.subjectIndex >= Object.keys(newState.players).length) {
        newState.status = 'RESULTS';
    } else {
        newState.status = 'QUIZ';
    }
    
    await updateRoomState(newState);
}

function showResults(players) {
    document.getElementById('quiz-screen').classList.add('hidden-screen');
    const resultsContainer = document.getElementById('results-screen');
    resultsContainer.classList.remove('hidden-screen');
    resultsContainer.classList.add('!max-w-3xl');

    // Restaurar título e botão original
    resultsContainer.querySelector('.text-center.mb-8').innerText = "Ranking Final";
    const oldBtn = resultsContainer.querySelector('.m3-btn-outline');
    if (oldBtn) oldBtn.classList.remove('hidden-screen');
    const nextBtn = resultsContainer.querySelector('.m3-btn-filled:not(#host-controls button)');
    if (nextBtn) nextBtn.remove();
    const history = resultsContainer.querySelector('.reveal-history');
    if (history) history.remove();

    const sorted = [...players].sort((a,b) => b.score - a.score);
    const rankingContainer = document.getElementById('ranking');

    rankingContainer.innerHTML = sorted.map((p, i) => `
        <div class="flex items-center justify-between p-5 bg-white/5 rounded-3xl border border-white/5 ${i===0?'ring-2 ring-google-yellow' : ''}">
            <div class="flex items-center gap-4">
                <span class="text-2xl font-black">${i===0?'🥇' : i+1}</span>
                <span class="text-lg font-bold text-white">${p.name}</span>
            </div>
            <div class="text-right">
                <span class="block text-2xl font-black text-google-blue">${p.score}</span>
                <span class="text-[10px] uppercase text-gray-500 font-bold tracking-widest">Pontos Totais</span>
            </div>
        </div>
    `).join('');
}

// --- UTILS ---

async function updateRoomState(newState) {
    await supabaseClient
        .from('rooms')
        .update({ data: newState })
        .eq('code', game.roomCode);
}

function shuffleArray(arr) {
    return arr.sort(() => Math.random() - 0.5);
}

// --- CHAT FUNCTIONS ---

function toggleChat() {
    game.chat.isOpen = !game.chat.isOpen;
    const windowEl = document.getElementById('chat-window');
    const badgeEl = document.getElementById('chat-badge');
    
    if (game.chat.isOpen) {
        windowEl.classList.add('open');
        game.chat.unreadCount = 0;
        badgeEl.classList.add('hidden');
        badgeEl.innerText = '0';
        document.getElementById('chat-input').focus();
        
        // Auto scroll ao abrir
        const msgs = document.getElementById('chat-messages');
        msgs.scrollTop = msgs.scrollHeight;
    } else {
        windowEl.classList.remove('open');
    }
}

function handleChatSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    
    if (!text) return;

    const messagePayload = {
        senderId: game.playerId,
        senderName: game.playerName || 'Anônimo',
        text: text,
        reply: game.chat.replyingTo
    };

    // Enviar via Broadcast
    if (game.subscription) {
        console.log("%c[Chat] Enviando Mensagem:", "color: #ffff00; font-weight: bold;", messagePayload);
        game.subscription.send({
            type: 'broadcast',
            event: 'chat_message',
            payload: messagePayload
        });
    } else {
        console.error("%c[Chat] Erro: Sem inscrição ativa no canal!", "color: #ff0000; font-weight: bold;");
    }

    // Renderizar para si mesmo localmente
    renderChatMessage(messagePayload);

    input.value = '';
    cancelReply();
}

function renderChatMessage(payload) {
    const container = document.getElementById('chat-messages');
    const isMe = payload.senderId === game.playerId;
    
    // Se o chat estiver fechado e a mensagem não for minha, aumenta unread
    if (!game.chat.isOpen && !isMe) {
        game.chat.unreadCount++;
        const badge = document.getElementById('chat-badge');
        badge.innerText = game.chat.unreadCount;
        badge.classList.remove('hidden');
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = `max-w-[85%] p-3 flex flex-col shadow-sm animate-fade ${isMe ? 'message-sent' : 'message-received'}`;
    
    let replyHtml = '';
    if (payload.reply) {
        replyHtml = `
            <div class="reply-indicator">
                <div class="font-bold opacity-70">${payload.reply.name}</div>
                <div class="truncate italic opacity-60">${payload.reply.text}</div>
            </div>
        `;
    }

    msgDiv.innerHTML = `
        ${!isMe ? `<span class="text-[10px] font-bold uppercase mb-1 opacity-50">${payload.senderName}</span>` : ''}
        ${replyHtml}
        <div class="text-sm leading-relaxed">${payload.text}</div>
    `;

    // Clique para responder
    msgDiv.onclick = () => {
        if (isMe) return;
        setReply(payload.senderName, payload.text);
    };
    msgDiv.style.cursor = 'pointer';

    container.appendChild(msgDiv);
    
    // Auto scroll
    container.scrollTop = container.scrollHeight;
}

function setReply(name, text) {
    game.chat.replyingTo = { name, text };
    document.getElementById('reply-name').innerText = name;
    document.getElementById('reply-text').innerText = text;
    document.getElementById('reply-preview').classList.remove('hidden');
    document.getElementById('chat-input').focus();
}

function cancelReply() {
    game.chat.replyingTo = null;
    document.getElementById('reply-preview').classList.add('hidden');
}
