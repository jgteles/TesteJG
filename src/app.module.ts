import { Module, OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { HealthController } from './health/health.controller';
import config from './mikro-orm.config';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: MikroORM,
      useFactory: async () => {
        const orm = await MikroORM.init(config);
        return orm;
      },
    },
  ],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly orm: MikroORM) {}

  async onModuleInit(): Promise<void> {
    await this.orm.connect();
  }
}
