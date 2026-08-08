import {
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductDto {
  @IsMongoId()
  sectionId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  purchasePrice: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salePrice: number;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  initialQuantity: number;
}
