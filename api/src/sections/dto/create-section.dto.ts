import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateSectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsString()
  @MaxLength(1000)
  description: string = '';
}
