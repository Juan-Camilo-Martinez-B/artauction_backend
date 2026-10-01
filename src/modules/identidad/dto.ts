import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'leo@artauction.local' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  password!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  displayName!: string;

  @ApiProperty({ required: false, enum: ['USER', 'SELLER'] })
  @IsOptional()
  @IsIn(['USER', 'SELLER'])
  role?: 'USER' | 'SELLER';
}

export class LoginDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  password!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @MinLength(20)
  refreshToken!: string;
}
