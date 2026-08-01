import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateObjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description: string;
}
