const clients = new Set();

export function addClient(socket) {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
}

export function removeClient(socket) {
  clients.delete(socket);
}

export function broadcast(event) {
  const data = JSON.stringify(event);
  const dead = [];
  for (const socket of clients) {
    try {
      if (socket.readyState !== 1) { dead.push(socket); continue; }
      socket.send(data);
    } catch {
      dead.push(socket);
    }
  }
  for (const s of dead) clients.delete(s);
}

export function closeAll() {
  for (const socket of clients) {
    try { socket.close(); } catch {}
  }
  clients.clear();
}
