const clients = new Set();

export function addClient(socket) {
  clients.add(socket);
}

export function removeClient(socket) {
  clients.delete(socket);
}

export function broadcast(event) {
  const data = JSON.stringify(event);
  for (const socket of clients) {
    try { socket.send(data); } catch {}
  }
}

export function closeAll() {
  for (const socket of clients) {
    try { socket.close(); } catch {}
  }
  clients.clear();
}
