import {
  Class,
  ConcreteClass,
} from '@app/shared/internals/utils/types/classes-types';
import { AuditContext } from 'src/internals/auditing/audit-context';
import {
  AbstractRepository,
  DeepPartial,
  EntityManager,
  FindOperator,
} from 'typeorm';
import { SimpleEntity } from './simple.entity';
import { generateUniqueUUID } from '../../utils/generate-unique-uuid';

type WhereObject<Entity extends SimpleEntity> = {
  [K in keyof Entity]?:
    | (Entity[K] extends {
        id: number | string;
      }
        ? Entity[K] | Entity[K]['id']
        : never)
    | Entity[K]
    | FindOperator<Entity[K]>;
};

export type Where<Entity extends SimpleEntity> =
  | WhereObject<Entity>
  | Array<WhereObject<Entity>>;

type FindOptionsBase<Entity extends SimpleEntity> = {
  withDeleted?: boolean;
  order?: {
    [K in keyof Entity]?: 'ASC' | 'DESC' | 1 | -1;
  };
};

export interface FindOneOptions<Entity extends SimpleEntity>
  extends FindOptionsBase<Entity> {
  where: Where<Entity>;
}

export interface FindOptions<Entity extends SimpleEntity>
  extends FindOptionsBase<Entity> {
  where?: Where<Entity>;
  skip: number;
}

export abstract class SimpleEntityRepository<
  Entity extends SimpleEntity,
  FieldsOmittedBeforePersistence extends keyof Entity = never,
> extends AbstractRepository<Entity> {
  _EntityCreationAttributes!: Omit<
    Entity,
    keyof SimpleEntity | FieldsOmittedBeforePersistence | 'toJSON'
  >;

  findOne(
    query: FindOneOptions<Entity>,
    options?: Partial<{ manager: EntityManager }>,
  ): Promise<Entity | undefined> {
    const repository = options?.manager
      ? options.manager.getRepository<Entity>(this.repository.target)
      : this.repository;

    return repository.findOne(query);
  }

  async find(
    query: FindOptions<Entity>,
    options?: Partial<{ manager: EntityManager }>,
  ) {
    const repository = options?.manager
      ? options.manager.getRepository<Entity>(this.repository.target)
      : this.repository;

    const limit = 50;
    const results = await repository.findAndCount({
      ...query,
      take: limit,
    });

    return {
      limit,
      total: results[1],
      rows: results[0],
    };
  }

  async create(
    entityLikeObject: this['_EntityCreationAttributes'],
    auditContext: AuditContext,
    options?: Partial<{ manager?: EntityManager }>,
  ): Promise<Entity> {
    const repository = options?.manager
      ? options.manager.getRepository<Entity>(this.repository.target)
      : this.repository;

    const _entityLikeObject = {
      ...entityLikeObject,
    } as Partial<Entity>;

    _entityLikeObject.id = generateUniqueUUID();

    const EntityClass = this.repository.target as ConcreteClass<
      Partial<Entity>
    >;

    const entity = new EntityClass();

    for (const _k of Object.keys(_entityLikeObject)) {
      const key = _k as keyof Partial<Entity>;

      entity[key] = _entityLikeObject[key];
    }

    await repository.save(entity as DeepPartial<Entity>);

    return entity as Entity;
  }

  async save(
    entity: Entity,
    auditContext: AuditContext,
    options?: Partial<{ manager?: EntityManager }>,
  ): Promise<void> {
    const EntityClass = this.repository.target as Class;

    if (!(entity instanceof EntityClass)) {
      throw new Error();
    }

    const repository = options?.manager
      ? options.manager.getRepository<Entity>(this.repository.target)
      : this.repository;

    await repository.save(entity as unknown as DeepPartial<Entity>);
  }

  async remove(
    entity: Entity,
    auditContext: AuditContext,
    manager?: EntityManager,
  ): Promise<void> {
    const EntityClass = this.repository.target as Class;

    if (!(entity instanceof EntityClass)) {
      throw new Error();
    }

    const repository = manager
      ? manager.getRepository<Entity>(EntityClass)
      : this.repository;

    if (this.repository.metadata.deleteDateColumn) {
      await repository.softRemove(entity as unknown as DeepPartial<Entity>);
    } else {
      await repository.remove(entity);
    }
  }
}
