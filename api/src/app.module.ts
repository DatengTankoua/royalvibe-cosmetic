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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
