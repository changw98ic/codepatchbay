type BroadcastClient = {
  send(data: string): void;
  close(): void;
};

const clients = new Set<BroadcastClient>();

export function addClient(socket: BroadcastClient) {
  clients.add(socket);
}

export function removeClient(socket: BroadcastClient) {
  clients.delete(socket);
}

export function broadcast(event: unknown) {
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
