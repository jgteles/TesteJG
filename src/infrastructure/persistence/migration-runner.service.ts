import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';

@Injectable()
export class MigrationRunnerService implements OnApplicationBootstrap {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.orm.migrator.up();
  }
}
