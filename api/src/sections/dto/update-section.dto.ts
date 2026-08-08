import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
