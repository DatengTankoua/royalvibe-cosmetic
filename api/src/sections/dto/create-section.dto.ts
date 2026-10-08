import {
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateSectionDto {
  @IsString()
  @IsNotEmpty()
  // A whitespace-only name is also rejected (class-validator's
  // IsNotEmpty alone passes "   "). No trimming is applied here.
  @Matches(/\S/, { message: 'name must contain a non-whitespace character' })
  @MaxLength(200)
  name: string;

  @IsString()
  @MaxLength(1000)
  description: string = '';

  @IsOptional()
  @IsMongoId()
  parentId?: string;
}
