import { Type } from 'class-transformer';
import { IsDefined, IsEnum, IsString, Matches, ValidateNested } from 'class-validator';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { MoneyDto } from './create-wallet.dto';

export class SubmitWagerTransactionDto {
  @IsString()
  @Matches(/\S/)
  providerId!: string;

  @IsString()
  @Matches(/\S/)
  externalTransactionId!: string;

  @IsString()
  @Matches(/\S/)
  playerId!: string;

  @IsString()
  @Matches(/\S/)
  walletId!: string;

  @IsString()
  @Matches(/\S/)
  roundId!: string;

  @IsString()
  @Matches(/\S/)
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;
}
