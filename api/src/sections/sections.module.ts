import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Section, SectionSchema } from './schemas/section.schema';
import { SectionsService } from './sections.service';
import { SectionsController } from './sections.controller';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Section.name, schema: SectionSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    // 1-15B : diffusion des signaux de section à la room de l'organisation.
    EventsModule,
  ],
  providers: [SectionsService],
  controllers: [SectionsController],
  exports: [SectionsService],
})
export class SectionsModule {}
