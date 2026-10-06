import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { S3Module } from './s3/s3.module';
import { EventsModule } from './events/events.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { SectionsModule } from './sections/sections.module';
import { ProductsModule } from './products/products.module';
import { SalesModule } from './sales/sales.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { TrashModule } from './trash/trash.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ImageSecurityModule } from './common/image/image-security.module';
import { PushModule } from './push/push.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 1-12D : politique Sharp du processus appliquée au bootstrap.
    ImageSecurityModule,
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
      }),
    }),
    S3Module,
    EventsModule,
    UsersModule,
    AuthModule,
    SectionsModule,
    ProductsModule,
    SalesModule,
    AuditModule,
    AnalyticsModule,
    TrashModule,
    // 1-1A : modèles multi-tenant (Organization + Membership), données seules.
    OrganizationsModule,
    // 1-16A : notifications Web Push (inactives tant que le démarrage HTTP
    // ne les active pas ; aucun traitement de fond au chargement).
    PushModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
