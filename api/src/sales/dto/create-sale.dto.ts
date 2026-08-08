import {
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSaleDto {
  @IsMongoId()
  productId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salePrice: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buyerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buyerContact?: string;
}
