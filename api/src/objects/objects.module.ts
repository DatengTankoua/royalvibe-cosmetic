import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ObjectsController } from './objects.controller';
import { ObjectsService } from './objects.service';
import { ObjectEntity, ObjectSchema } from './schemas/object.schema';
import { S3Module } from '../s3/s3.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ObjectEntity.name, schema: ObjectSchema },
    ]),
    S3Module,
    EventsModule,
  ],
  controllers: [ObjectsController],
  providers: [ObjectsService],
})
export class ObjectsModule {}
