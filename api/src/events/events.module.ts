import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { EventsGateway } from './events.gateway';

/**
 * Phase 0B.3 : EventsGateway a besoin de JwtService (AuthModule) et
 * UsersService (UsersModule) pour authentifier le handshake Socket.IO.
 * Ces modules sont importés pour l'accès — pas de modification de leur
 * périmètre.
 */
@Module({
  imports: [AuthModule, UsersModule, OrganizationsModule],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
