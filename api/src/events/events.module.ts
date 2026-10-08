import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UsersModule } from '../users/users.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { EventsGateway } from './events.gateway';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Phase 0B.3 : EventsGateway a besoin de JwtService (AuthModule) et
 * UsersService (UsersModule) pour authentifier le handshake Socket.IO.
 * Ces modules sont importés pour l'accès — pas de modification de leur
 * périmètre.
 */
@Module({
  // 1-14C.1 : SubscriptionsModule — contrôle commercial des sockets.
  // 1-16A.1 : NotificationsModule — signal privé `notifications:changed`.
  imports: [
    AuthModule,
    UsersModule,
    OrganizationsModule,
    SubscriptionsModule,
    NotificationsModule,
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
