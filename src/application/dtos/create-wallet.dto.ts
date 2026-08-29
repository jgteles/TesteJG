import { Type } from 'class-transformer';
import { IsDefined, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';

export class MoneyDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  amount!: string;

  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;
}

export class CreateWalletDto {
  @IsString()
  @Matches(/\S/)
  playerId!: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance?: MoneyDto;
}
