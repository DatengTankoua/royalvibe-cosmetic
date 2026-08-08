import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Section, SectionSchema } from './schemas/section.schema';
import { SectionsService } from './sections.service';
import { SectionsController } from './sections.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Section.name, schema: SectionSchema }]),
  ],
  providers: [SectionsService],
  controllers: [SectionsController],
  exports: [SectionsService],
})
export class SectionsModule {}
