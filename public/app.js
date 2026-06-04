const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  me: null,
  friends: [],
  blocked: [],
  incoming: [],
  outgoing: [],
  selectedFriend: null,
  messages: [],
  rooms: [],
  room: null,
  ws: null,
  authMode: "login"
};

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "操作失败");
  return data;
}

function fmt(ts) {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}

async function boot() {
  bindEvents();
  try {
    const data = await api("/api/me");
    enterApp(data);
  } catch {
    $("#authScreen").classList.remove("hidden");
  }
}

function bindEvents() {
  $$(".tabs [data-auth]").forEach(btn => btn.addEventListener("click", () => {
    state.authMode = btn.dataset.auth;
    $$(".tabs [data-auth]").forEach(b => b.classList.toggle("active", b === btn));
    $("#nameRow").hidden = state.authMode !== "register";
    $(".auth-box .primary").textContent = state.authMode === "login" ? "进入" : "创建账号";
  }));

  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const payload = {
        id: $("#authId").value,
        password: $("#authPassword").value,
        name: $("#authName").value
      };
      if (state.authMode === "register") {
        await api("/api/register", { method: "POST", body: JSON.stringify(payload) });
      }
      const data = await api("/api/login", { method: "POST", body: JSON.stringify(payload) });
      enterApp({ user: data.user, friends: [], blocked: [], incoming: [], outgoing: [] });
      await refreshMe();
    } catch (err) { toast(err.message); }
  });

  $("#logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    location.reload();
  });

  $$(".nav").forEach(btn => btn.addEventListener("click", () => showView(btn.dataset.view)));
  $("#searchBtn").addEventListener("click", searchUsers);
  $("#searchInput").addEventListener("keydown", e => { if (e.key === "Enter") searchUsers(); });
  $("#messageForm").addEventListener("submit", sendMessage);
  $("#momentForm").addEventListener("submit", publishMoment);
  $("#createRoomBtn").addEventListener("click", createRoom);
}

function enterApp(data) {
  state.me = data.user;
  $("#authScreen").classList.add("hidden");
  $("#mainShell").classList.remove("hidden");
  connectWs();
  refreshMe();
  loadMoments();
  loadRooms();
}

function connectWs() {
  if (state.ws) state.ws.close();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(`${proto}//${location.host}`);
  state.ws.onmessage = (event) => {
    const { event: type, payload } = JSON.parse(event.data);
    if (["friend-request", "friend-updated"].includes(type)) refreshMe();
    if (type === "message") {
      if (state.selectedFriend && payload.conversationId === conversationId(state.me.id, state.selectedFriend.id)) loadMessages(state.selectedFriend.id);
      else refreshMe();
      if (state.me?.role === "admin") loadAdminMessages();
    }
    if (type === "message-read" && state.selectedFriend) loadMessages(state.selectedFriend.id);
    if (type === "message-read" && state.me?.role === "admin") loadAdminMessages();
    if (type === "moment") loadMoments();
    if (type === "rooms") state.rooms = payload.rooms, renderRooms();
    if (type === "room-invite") {
      toast(`${payload.from?.name || "好友"} 邀请你加入房间：${payload.room.name}`);
      loadRooms();
    }
    if (type === "room-deleted") {
      if (state.room?.id === payload.id) {
        state.room = null;
        renderGame();
      }
      loadRooms();
    }
    if (type === "room") {
      if (state.room?.id === payload.id) state.room = payload, renderGame();
      loadRooms();
    }
  };
}

async function refreshMe() {
  const data = await api("/api/me");
  Object.assign(state, {
    me: data.user,
    friends: data.friends,
    blocked: data.blocked,
    incoming: data.incoming,
    outgoing: data.outgoing
  });
  $("#meName").textContent = state.me.name;
  $("#meId").textContent = `@${state.me.id}`;
  $("#avatar").textContent = state.me.name.slice(0, 1).toUpperCase();
  $("#rolePill").textContent = "在线";
  $("#adminAudit").classList.toggle("hidden", state.me.role !== "admin");
  if (state.me.role === "admin") loadAdminMessages();
  renderFriends();
  renderRequests();
}

function showView(view) {
  const titles = { chat: ["聊天", "选择好友开始对话"], friends: ["好友", "检索、申请、删除或拉黑用户"], moments: ["公共空间", "登录用户都能浏览和互动"], games: ["游戏", "好友组队开局，无次数限制"] };
  $$(".nav").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.add("hidden"));
  $(`#${view}View`).classList.remove("hidden");
  $("#viewTitle").textContent = titles[view][0];
  $("#viewSub").textContent = titles[view][1];
  if (view === "moments") loadMoments();
  if (view === "games") loadRooms();
}

function renderFriends() {
  $("#friendList").innerHTML = state.friends.map(f => `
    <button class="friend-item ${state.selectedFriend?.id === f.id ? "active" : ""}" data-chat="${f.id}">
      <span><strong>${escapeHtml(f.name)}</strong><small>@${f.id}</small></span>
      <span>›</span>
    </button>`).join("");
  $$("[data-chat]").forEach(btn => btn.addEventListener("click", () => selectFriend(btn.dataset.chat)));
}

async function selectFriend(id) {
  state.selectedFriend = state.friends.find(f => f.id === id);
  $("#chatTarget").textContent = state.selectedFriend ? `${state.selectedFriend.name} @${state.selectedFriend.id}` : "未选择好友";
  renderFriends();
  showView("chat");
  await loadMessages(id);
}

function conversationId(a, b) {
  return [a, b].sort().join("__");
}

async function loadMessages(friendId) {
  const data = await api(`/api/messages/${friendId}`);
  state.messages = data.messages;
  renderMessages();
}

function renderMessages() {
  const box = $("#messages");
  box.innerHTML = state.messages.map(m => {
    const mine = m.from === state.me.id;
    const read = state.me.role === "admin" ? `<span class="read">${m.readAt ? "已读" : "未读"}</span>` : "";
    return `<div class="msg ${mine ? "mine" : ""}">
      <div class="bubble">
        ${m.text ? `<div>${escapeHtml(m.text)}</div>` : ""}
        ${m.image ? `<img class="chat-img" src="${m.image}" alt="聊天图片">` : ""}
      </div>
      <div class="meta">${escapeHtml(m.from)} · ${fmt(m.createdAt)} ${read}</div>
    </div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

async function loadAdminMessages() {
  const { messages } = await api("/api/admin/messages");
  $("#auditList").innerHTML = messages.map(m => `
    <div class="audit-row">
      <strong>${escapeHtml(m.fromUser?.name || m.from)} → ${escapeHtml(m.toUser?.name || m.to)}</strong>
      <span>${escapeHtml(m.text)}</span>
      <small>${m.readAt ? `<span class="read">已读</span> ${fmt(m.readAt)}` : "未读"}</small>
    </div>`).join("") || "<p class='hint'>暂无私聊消息</p>";
}

async function sendMessage(e) {
  e.preventDefault();
  if (!state.selectedFriend) return toast("请先选择好友");
  const text = $("#messageInput").value.trim();
  const image = await fileToDataUrl($("#messageImage").files[0]);
  if (!text && !image) return;
  try {
    await api("/api/messages", { method: "POST", body: JSON.stringify({ to: state.selectedFriend.id, text, image }) });
    $("#messageInput").value = "";
    $("#messageImage").value = "";
    await loadMessages(state.selectedFriend.id);
  } catch (err) { toast(err.message); }
}

async function searchUsers() {
  const q = $("#searchInput").value.trim();
  if (!q) return toast("请输入用户 ID 或昵称");
  try {
    const { users } = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
    const visible = users.filter(u => u.id !== state.me.id);
    $("#searchResults").innerHTML = visible.map(u => {
      const isFriend = u.relation === "friend" || state.friends.some(f => f.id === u.id);
      const pending = Boolean(u.pending);
      const blocked = Boolean(u.blocked);
      const addButton = isFriend
        ? `<button disabled>已是好友</button>`
        : pending
          ? `<button disabled>已申请</button>`
          : blocked
            ? `<button disabled>已拉黑</button>`
            : `<button class="primary" data-add="${u.id}">加好友</button>`;
      return `
      <div class="card">
        <strong>${escapeHtml(u.name)}</strong><small>@${u.id}</small>
        <div class="actions">
          ${addButton}
          ${blocked ? `<button data-unblock="${u.id}">解除拉黑</button>` : `<button data-block="${u.id}">拉黑</button>`}
          ${isFriend ? `<button class="danger" data-del="${u.id}">删除好友</button>` : ""}
        </div>
      </div>`;
    }).join("") || "<p class='hint'>没有搜到用户</p>";
    bindUserActions();
  } catch (err) { toast(err.message); }
}

function renderRequests() {
  $("#requests").innerHTML = state.incoming.map(r => `
    <div class="card">
      <strong>@${r.from}</strong><small>${fmt(r.createdAt)}</small>
      <div class="actions">
        <button class="primary" data-accept="${r.id}">同意</button>
        <button data-reject="${r.id}">拒绝</button>
      </div>
    </div>`).join("");
  $("#blockedList").innerHTML = state.blocked.map(u => `
    <div class="card">
      <strong>${escapeHtml(u.name)}</strong><small>@${u.id}</small>
      <div class="actions"><button data-unblock="${u.id}">解除拉黑</button></div>
    </div>`).join("");
  bindUserActions();
}

function bindUserActions() {
  $$("[data-add]").forEach(b => b.onclick = () => api("/api/friends/request", { method: "POST", body: JSON.stringify({ to: b.dataset.add }) }).then(() => toast("申请已发送")).catch(e => toast(e.message)));
  $$("[data-accept]").forEach(b => b.onclick = () => respond(b.dataset.accept, "accept"));
  $$("[data-reject]").forEach(b => b.onclick = () => respond(b.dataset.reject, "reject"));
  $$("[data-del]").forEach(b => b.onclick = () => api(`/api/friends/${b.dataset.del}`, { method: "DELETE" }).then(refreshMe));
  $$("[data-block]").forEach(b => b.onclick = () => api("/api/block", { method: "POST", body: JSON.stringify({ targetId: b.dataset.block, blocked: true }) }).then(refreshMe));
  $$("[data-unblock]").forEach(b => b.onclick = () => api("/api/block", { method: "POST", body: JSON.stringify({ targetId: b.dataset.unblock, blocked: false }) }).then(refreshMe));
}

async function respond(id, action) {
  await api(`/api/friends/respond/${id}`, { method: "POST", body: JSON.stringify({ action }) });
  await refreshMe();
}

async function fileToDataUrl(file) {
  if (!file) return "";
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function publishMoment(e) {
  e.preventDefault();
  try {
    const image = await fileToDataUrl($("#momentImage").files[0]);
    await api("/api/moments", { method: "POST", body: JSON.stringify({ text: $("#momentText").value, image }) });
    $("#momentText").value = "";
    $("#momentImage").value = "";
    await loadMoments();
  } catch (err) { toast(err.message); }
}

async function loadMoments() {
  const { moments } = await api("/api/moments");
  $("#moments").innerHTML = moments.map(m => `
    <article class="card">
      <strong>${escapeHtml(m.user?.name || m.userId)}</strong><small>@${m.userId} · ${fmt(m.createdAt)}</small>
      <p>${escapeHtml(m.text)}</p>
      ${m.image ? `<img class="moment-img" src="${m.image}" alt="动态图片">` : ""}
      <div class="actions">
        <button data-like-moment="${m.id}">${(m.likes || []).includes(state.me.id) ? "已点赞" : "点赞"} · ${(m.likes || []).length}</button>
        ${m.userId === state.me.id || state.me.role === "admin" ? `<button class="danger" data-delete-moment="${m.id}">删除</button>` : ""}
      </div>
    </article>`).join("");
  $$("[data-like-moment]").forEach(b => b.onclick = () => likeMoment(b.dataset.likeMoment));
  $$("[data-delete-moment]").forEach(b => b.onclick = () => deleteMoment(b.dataset.deleteMoment));
}

async function likeMoment(id) {
  try {
    await api(`/api/moments/${id}/like`, { method: "POST", body: "{}" });
    await loadMoments();
  } catch (err) { toast(err.message); }
}

async function deleteMoment(id) {
  if (!confirm("删除这条动态？")) return;
  try {
    await api(`/api/moments/${id}`, { method: "DELETE" });
    await loadMoments();
  } catch (err) { toast(err.message); }
}

async function loadRooms() {
  const { rooms } = await api("/api/rooms");
  state.rooms = rooms;
  renderRooms();
}

function renderRooms() {
  $("#roomList").innerHTML = state.rooms.map(r => `
    <div class="card">
      <strong>${escapeHtml(r.name)}</strong>
      <small>${r.type === "bombcat" ? "炸弹猫" : "你画我猜"} · ${r.players.length} 人</small>
      <div class="actions">
        <button class="primary" data-join="${r.id}">进入</button>
        ${r.owner === state.me.id || state.me.role === "admin" ? `<button class="danger" data-delete-room="${r.id}">删除</button>` : ""}
      </div>
    </div>`).join("");
  $$("[data-join]").forEach(b => b.onclick = () => joinRoom(b.dataset.join));
  $$("[data-delete-room]").forEach(b => b.onclick = () => deleteRoom(b.dataset.deleteRoom));
}

async function createRoom() {
  try {
    const { room } = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name: $("#roomName").value, type: $("#roomType").value }) });
    state.room = room;
    renderGame();
    await loadRooms();
  } catch (err) { toast(err.message); }
}

async function joinRoom(id) {
  const { room } = await api(`/api/rooms/${id}/join`, { method: "POST", body: "{}" });
  state.room = room;
  renderGame();
}

async function deleteRoom(id) {
  if (!confirm("删除这个游戏房间？")) return;
  try {
    await api(`/api/rooms/${id}`, { method: "DELETE" });
    if (state.room?.id === id) state.room = null;
    renderGame();
    await loadRooms();
  } catch (err) { toast(err.message); }
}

async function inviteToRoom(userId) {
  if (!state.room) return;
  try {
    const { room } = await api(`/api/rooms/${state.room.id}/invite`, { method: "POST", body: JSON.stringify({ userId }) });
    state.room = room;
    renderGame();
    toast("已发送邀请");
  } catch (err) { toast(err.message); }
}

async function roomAction(action) {
  if (!state.room) return;
  const { room } = await api(`/api/rooms/${state.room.id}/action`, { method: "POST", body: JSON.stringify(action) });
  state.room = room;
  renderGame();
}

function renderGame() {
  const room = state.room;
  if (!room) {
    $("#gameStage").innerHTML = "<p class='hint'>选择或创建房间开始游戏。</p>";
    return;
  }
  if (room.type === "drawguess") return renderDrawGuess(room);
  return renderBombCat(room);
}

function playersHtml(room) {
  return `<div class="players">${room.players.map(p => `<span class="chip">${escapeHtml(p.name)} ${p.score ? `· ${p.score}` : ""}</span>`).join("")}</div>`;
}

function inviteHtml(room) {
  const playerIds = new Set(room.players.map(p => p.id));
  const invited = new Set(room.invited || []);
  const candidates = state.friends.filter(f => !playerIds.has(f.id));
  if (!candidates.length) return "";
  return `<div class="invite-panel">
    <small>邀请好友</small>
    <div class="actions">
      ${candidates.map(f => `<button data-invite="${f.id}">${escapeHtml(f.name)}${invited.has(f.id) ? " · 已邀请" : ""}</button>`).join("")}
    </div>
  </div>`;
}

function bindInviteButtons() {
  $$("[data-invite]").forEach(b => b.onclick = () => inviteToRoom(b.dataset.invite));
}

function renderDrawGuess(room) {
  const s = room.state;
  const isDrawer = s.drawer === state.me.id;
  $("#gameStage").innerHTML = `
    <h3>${escapeHtml(room.name)}</h3>
    ${playersHtml(room)}
    ${inviteHtml(room)}
    <div class="actions">
      <button class="primary" id="startDraw">开始新轮</button>
      <button id="clearCanvas" ${isDrawer ? "" : "disabled"}>清空画布</button>
    </div>
    <p class="hint">${isDrawer ? `你来画：${escapeHtml(s.word)}` : `作画者：${escapeHtml(room.players.find(p => p.id === s.drawer)?.name || "待开始")}`}</p>
    <div class="canvas-wrap"><canvas id="drawCanvas" width="960" height="540"></canvas></div>
    <div class="composer" style="margin-top:10px">
      <input id="guessInput" placeholder="输入猜测">
      <button class="primary" id="guessBtn">提交</button>
    </div>
    <div class="guess-log">${s.guesses.map(g => `<div>${escapeHtml(g.name)}：${escapeHtml(g.text)} ${g.hit ? "命中" : ""}</div>`).join("")}</div>
  `;
  $("#startDraw").onclick = () => roomAction({ kind: "start" });
  $("#clearCanvas").onclick = () => roomAction({ kind: "clear" });
  $("#guessBtn").onclick = () => roomAction({ kind: "guess", text: $("#guessInput").value });
  bindInviteButtons();
  setupCanvas(room, isDrawer);
}

function setupCanvas(room, canDraw) {
  const canvas = $("#drawCanvas");
  const ctx = canvas.getContext("2d");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#17202a";
  for (const stroke of room.state.strokes || []) drawStroke(ctx, stroke);
  if (!canDraw) return;
  let current = null;
  const point = (e) => {
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches?.[0] || e;
    return { x: (touch.clientX - rect.left) / rect.width * canvas.width, y: (touch.clientY - rect.top) / rect.height * canvas.height };
  };
  const start = e => { e.preventDefault(); current = [point(e)]; };
  const move = e => {
    if (!current) return;
    e.preventDefault();
    current.push(point(e));
    drawStroke(ctx, current.slice(-2));
  };
  const end = () => {
    if (current?.length > 1) roomAction({ kind: "stroke", stroke: current });
    current = null;
  };
  canvas.onpointerdown = start;
  canvas.onpointermove = move;
  canvas.onpointerup = end;
  canvas.onpointerleave = end;
}

function drawStroke(ctx, stroke) {
  if (!stroke || stroke.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(stroke[0].x, stroke[0].y);
  for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

function renderBombCat(room) {
  const s = room.state;
  const current = s.alive?.[s.turn % Math.max(1, s.alive.length)];
  const myTurn = current === state.me.id;
  const hand = s.hand || [];
  const hasSkip = hand.includes("跳过");
  const hasPeek = hand.includes("预言");
  $("#gameStage").innerHTML = `
    <h3>${escapeHtml(room.name)}</h3>
    ${playersHtml(room)}
    ${inviteHtml(room)}
    <p class="hint">状态：${s.phase} ${current ? `· 当前：${escapeHtml(room.players.find(p => p.id === current)?.name || current)}` : ""}</p>
    <div class="players">${hand.map(card => `<span class="chip">${escapeHtml(card)}</span>`).join("") || "<span class='chip'>暂无手牌</span>"}</div>
    <div class="actions">
      <button class="primary" id="startBomb">开始/重开</button>
      <button id="playSkip" ${myTurn && hasSkip ? "" : "disabled"}>出跳过</button>
      <button id="playPeek" ${myTurn && hasPeek ? "" : "disabled"}>出预言</button>
      <button id="drawCard" ${myTurn ? "" : "disabled"}>抽牌</button>
    </div>
    <div class="game-log">${(s.log || []).map(line => `<div>${escapeHtml(line)}</div>`).join("")}</div>
  `;
  $("#startBomb").onclick = () => roomAction({ kind: "start" });
  $("#playSkip").onclick = () => roomAction({ kind: "play", card: "跳过" });
  $("#playPeek").onclick = () => roomAction({ kind: "play", card: "预言" });
  $("#drawCard").onclick = () => roomAction({ kind: "draw" });
  bindInviteButtons();
}

boot();
