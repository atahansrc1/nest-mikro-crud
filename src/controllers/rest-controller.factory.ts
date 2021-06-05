import {
  Body,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Type,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import e from "express";
import { FindConditions } from "typeorm";
import { AbstractFactory } from "../abstract.factory";
import { REST_FACTORY_METADATA_KEY, TS_TYPE_METADATA_KEY } from "../constants";
import { ReqUser } from "../decorators";
import { QueryDtoFactory } from "../dtos";
import { RestService, RestServiceFactory } from "../services";
import { ActionName, LookupableField } from "../types";
import { RestControllerFactoryOptions } from "./rest-controller-factory-options.interface";
import { RestController } from "./rest-controller.interface";

type ServiceGenerics<Service> = Service extends RestService<
  infer Entity,
  infer CreateDto,
  infer UpdateDto
>
  ? {
      Entity: Entity;
      CreateDto: CreateDto;
      UpdateDto: UpdateDto;
    }
  : never;

// TODO: make the generic type `LookupField` literal
export class RestControllerFactory<
  Service extends RestService<Entity, CreateDto, UpdateDto> = RestService,
  Entity = ServiceGenerics<Service>["Entity"],
  CreateDto = ServiceGenerics<Service>["CreateDto"],
  UpdateDto = ServiceGenerics<Service>["UpdateDto"],
  LookupField extends LookupableField<Entity> = LookupableField<Entity>
> extends AbstractFactory<
  RestController<Entity, CreateDto, UpdateDto, LookupField, Service>
> {
  readonly serviceFactory;
  readonly options;
  readonly product;

  constructor(
    options: RestControllerFactoryOptions<
      Entity,
      CreateDto,
      UpdateDto,
      LookupField,
      Service
    >
  ) {
    super();

    this.serviceFactory = Reflect.getMetadata(
      REST_FACTORY_METADATA_KEY,
      options.restServiceClass
    ) as RestServiceFactory<Entity, CreateDto, UpdateDto>;

    this.options = this.standardizeOptions(options);

    this.product = this.createRawClass();
    this.defineInjections();
    this.buildActions();
    this.applyClassDecorators(
      UsePipes(new ValidationPipe(this.options.validationPipeOptions))
    );

    Reflect.defineMetadata(REST_FACTORY_METADATA_KEY, this, this.product);
  }

  protected standardizeOptions(
    options: RestControllerFactoryOptions<
      Entity,
      CreateDto,
      UpdateDto,
      LookupField,
      Service
    >
  ) {
    const {
      queryDtoClass = new QueryDtoFactory({}).product,
      lookup,
      requestUser = { decorators: [ReqUser()] },
      validationPipeOptions = {},
    } = options;

    return {
      ...options,
      queryDtoClass,
      lookup: {
        ...lookup,
        type:
          lookup.type ??
          (Reflect.getMetadata(
            TS_TYPE_METADATA_KEY,
            this.serviceFactory.options.entityClass.prototype,
            lookup.field
          ) as typeof lookup.type)!,
        name: lookup.name ?? "lookup",
      },
      requestUser: {
        ...requestUser,
        type: requestUser.type ?? Object,
      },
      validationPipeOptions: {
        ...validationPipeOptions,
        transform: true,
        transformOptions: {
          ...validationPipeOptions.transformOptions,
          exposeDefaultValues: true,
        },
      },
    };
  }

  /**
   * Create a no-metadata controller class
   */
  protected createRawClass() {
    const {
      lookup: { field: lookupField },
    } = this.options;

    const getLookupConditions = (value: unknown) =>
      ({
        [lookupField]: value,
      } as unknown as FindConditions<Entity>);

    type Interface = RestController<
      Entity,
      CreateDto,
      UpdateDto,
      LookupField,
      Service
    >;
    return class RestController implements Interface {
      readonly service!: Interface["service"];

      async list(
        ...[
          { limit, offset, expand, order, filter },
          user,
          ...args
        ]: Parameters<Interface["list"]>
      ): Promise<unknown> {
        const action: ActionName = "list";
        await this.service.checkPermission({ action, user });
        const data = await this.service.list({
          limit,
          offset,
          expand,
          order,
          filter,
          user,
        });
        data.results = await Promise.all(
          data.results.map((entity) => this.service.transform({ entity }))
        );
        return data;
      }

      async create(
        ...[{ expand }, data, user]: Parameters<Interface["create"]>
      ): Promise<unknown> {
        const action: ActionName = "create";
        await this.service.checkPermission({ action, user });
        let entity = await this.service.create({ data, user });
        const conditions = getLookupConditions(entity[lookupField]);
        entity = await this.service.retrieve({ conditions, expand, user });
        return await this.service.transform({ entity });
      }

      async retrieve(
        ...[lookup, { expand }, user]: Parameters<Interface["retrieve"]>
      ): Promise<unknown> {
        const action: ActionName = "retrieve";
        await this.service.checkPermission({ action, user });
        const conditions = getLookupConditions(lookup);
        let entity: Entity;
        entity = await this.service.retrieve({ conditions, expand, user });
        await this.service.checkPermission({ action, entity, user });
        return await this.service.transform({ entity });
      }

      async replace(
        ...[lookup, { expand }, data, user]: Parameters<Interface["replace"]>
      ): Promise<unknown> {
        const action: ActionName = "update";
        await this.service.checkPermission({ action, user });
        let conditions = getLookupConditions(lookup);
        let entity: Entity;
        entity = await this.service.retrieve({ conditions, expand, user });
        await this.service.checkPermission({ action, entity, user });
        await this.service.replace({ entity, data, user });
        conditions = getLookupConditions(entity[lookupField]); // lookup may be updated
        entity = await this.service.retrieve({ conditions, expand, user });
        return await this.service.transform({ entity });
      }

      async update(
        ...[lookup, { expand }, data, user]: Parameters<Interface["update"]>
      ): Promise<unknown> {
        const action: ActionName = "update";
        await this.service.checkPermission({ action, user });
        let conditions = getLookupConditions(lookup);
        let entity: Entity;
        entity = await this.service.retrieve({ conditions, expand, user });
        await this.service.checkPermission({ action, entity, user });
        await this.service.update({ entity, data, user });
        conditions = getLookupConditions(entity[lookupField]); // lookup may be updated
        entity = await this.service.retrieve({ conditions, expand, user });
        return await this.service.transform({ entity });
      }

      async destroy(
        ...[lookup, { expand }, user]: Parameters<Interface["destroy"]>
      ): Promise<unknown> {
        const action: ActionName = "destroy";
        await this.service.checkPermission({ action, user });
        const conditions = getLookupConditions(lookup);
        let entity: Entity;
        entity = await this.service.retrieve({ conditions, expand, user });
        await this.service.checkPermission({ action, entity, user });
        await this.service.destroy({ entity, user });
        return;
      }
    };
  }

  protected defineInjections() {
    const { restServiceClass } = this.options;

    this.defineType("service", restServiceClass).applyPropertyDecorators(
      "service" as any, // service is generic so the type cannot be inferred correctly
      Inject(restServiceClass)
    );
  }

  protected buildActions() {
    const {
      lookup: { type: lookupType, name: lookupParamName },
    } = this.options;

    const {
      dtoClasses: { create: createDto, update: updateDto },
    } = this.serviceFactory.options;
    const {
      queryDtoClass,
      requestUser: { type: reqUserType, decorators: reqUserDecorators },
    } = this.options;

    const path = `:${lookupParamName}`;

    const Lookup = Param(
      lookupParamName,
      ...(lookupType == Number ? [ParseIntPipe] : [])
    );
    const Queries = Query();
    const Data = Body();

    const table: Record<
      ActionName,
      [MethodDecorator[], Type[], ParameterDecorator[][]]
    > = {
      list: [[Get()], [queryDtoClass], [[Queries]]],
      create: [[Post()], [queryDtoClass, createDto], [[Queries], [Data]]],
      retrieve: [
        [Get(path)],
        [lookupType, queryDtoClass],
        [[Lookup], [Queries]],
      ],
      replace: [
        [Put(path)],
        [lookupType, queryDtoClass, createDto],
        [[Lookup], [Queries], [Data]],
      ],
      update: [
        [Patch(path)],
        [lookupType, queryDtoClass, updateDto],
        [[Lookup], [Queries], [Data]],
      ],
      destroy: [
        [Delete(path), HttpCode(204)],
        [lookupType, queryDtoClass],
        [[Lookup], [Queries]],
      ],
    };

    for (const [
      k,
      [methodDecorators, paramTypes, paramDecoratorSets],
    ] of Object.entries(table)) {
      const name = k as ActionName;
      if (this.options.actions.includes(name))
        this.applyMethodDecorators(name, ...methodDecorators);
      this.defineParamTypes(
        name,
        ...paramTypes,
        reqUserType
      ).applyParamDecoratorSets(name, ...paramDecoratorSets, reqUserDecorators);
    }
  }
}
