import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Section, SectionSchema } from './schemas/section.schema';
import { SectionsService } from './sections.service';
import { SectionsController } from './sections.controller';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { EventsModule } from '../events/events.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Section.name, schema: SectionSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    // 1-15B : diffusion des signaux de section à la room de l'organisation.
    EventsModule,
    // 1-19A : activité des membres annoncée au propriétaire.
    PushModule,
  ],
  providers: [SectionsService],
  controllers: [SectionsController],
  exports: [SectionsService],
})
export class SectionsModule {}
