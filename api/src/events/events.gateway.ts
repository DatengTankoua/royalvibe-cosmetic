import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Injectable } from '@nestjs/common';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class EventsGateway {
  @WebSocketServer()
  server: Server;

  emit(event: string, payload: unknown): void {
    this.server.emit(event, payload);
  }

  // Legacy helpers kept for backward compatibility
  emitObjectCreated(object: unknown) {
    this.server.emit('object:created', object);
  }

  emitObjectDeleted(id: string) {
    this.server.emit('object:deleted', id);
  }
}
