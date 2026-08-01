import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ObjectsController } from './objects.controller';
import { ObjectsService } from './objects.service';
import { ObjectEntity, ObjectSchema } from './schemas/object.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ObjectEntity.name, schema: ObjectSchema },
    ]),
  ],
  controllers: [ObjectsController],
  providers: [ObjectsService],
})
export class ObjectsModule {}
