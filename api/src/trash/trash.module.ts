import { Module } from '@nestjs/common';
import { TrashController } from './trash.controller';
import { SectionsModule } from '../sections/sections.module';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [SectionsModule, ProductsModule],
  controllers: [TrashController],
})
export class TrashModule {}
