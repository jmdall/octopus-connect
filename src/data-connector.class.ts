/**
 * Created by Christophe on 10/10/2017.
 */
import {DataConnectorConfig} from "./data-connector-config.interface";
import {DataEntity} from "./data-structures/data-entity.class";
import {Observable} from "rxjs/Rx";
import {DataCollection} from "./data-structures/data-collection.class";
import {ExternalInterface} from "./data-interfaces/abstract-external-interface.class";
import {LocalStorage} from "./data-interfaces/local-storage/local-storage.class";
import {CollectionDataSet, EntityDataSet, FilterData} from "./types";
import {Http} from "./data-interfaces/http/http.class";
import {Nodejs} from "./data-interfaces/nodejs/nodejs.class";
import {CollectionStore} from "./stores/collection-store.class";
import {EntityStore} from "./stores/entity-store.class";
import {ReplaySubject} from "rxjs/Rx";
import {EndpointConfig} from "./endpoint-config.interface";
import {ModelSchema} from "octopus-model";
import {InterfaceError} from "./data-interfaces/interface-error.class";

/**
 * Data connector class
 */
export class DataConnector {

    /**
     * Available interfaces
     * @type {{}} External interfaces, indexed by name
     */
    private interfaces:{[key:string]:ExternalInterface} = {};

    /**
     * Entities store
     * @type {{}} Entities stores, indexed by endpoint name
     */
    private entitiesLiveStore:{[key:string]:EntityStore} = {};

    /**
     * Collections store
     * @type {{}} Collections stores, indexed by endpoint name
     */
    private collectionsLiveStore:{[key:string]:CollectionStore} = {};

    /**
     * Built-in external interfaces
     * @type {{}}
     */
    private builtInFactories:{[key:string]:any} = {
        localstorage: LocalStorage,
        http: Http,
        nodejs: Nodejs
    };

    /**
     * Delay before action retry
     */
    private retryTimeout:number;

    /**
     * Max attempts number
     */
    private maxRetry:number;

    /**
     * Create a dataConnector
     * @param {DataConnectorConfig} configuration Data connector configuration
     */
    constructor(
        private configuration:DataConnectorConfig
    ) {
        for (let interfaceName in configuration.configuration) {
            if (configuration.configuration.hasOwnProperty(interfaceName)) {
                this.interfaces[interfaceName] = new this.builtInFactories[interfaceName](configuration.configuration[interfaceName], this);
            }
        }

        this.retryTimeout = this.configuration.retryTimeout || 2000;
        this.maxRetry = this.configuration.maxRetry || 10;
    }

    /**
     * Get data interface by endpoint name
     * @param {string} type Endpoint name
     * @returns {ExternalInterface} External interface
     */
    private getInterface(type:string):ExternalInterface {
        let conf:string|EndpointConfig = this.getEndpointConfiguration(type);

        if (typeof conf === "string") {
            return this.interfaces[conf];
        } else if (conf && conf.type) {
            return this.interfaces[conf.type];
        } else {
            return this.interfaces[this.configuration.defaultInterface];
        }
    }

    /**
     * Get endpoint configuration
     * @param {string} type Endpoint name
     * @returns {string | EndpointConfig} Type of the endpoint, or endpoint configuration object
     */
    private getEndpointConfiguration(type:string):string|EndpointConfig {
        return this.configuration.map[type];
    }

    /**
     * Get model schema used by the endpoint
     * @param {string} type Endpoint name
     * @returns {ModelSchema} The model schema
     */
    private getEndpointStructureModel(type:string):ModelSchema {
        let conf:string|EndpointConfig = this.getEndpointConfiguration(type);

        if (conf && typeof conf === "object") {
            return conf.structure;
        }
    }

    /**
     * Get nesting attributes types
     * @param {string} type Endpoint name
     * @returns {{[p: string]: string}} The nested attributes types
     */
    private getNesting(type:string):{[key:string]:string} {
        let conf:string|EndpointConfig = this.getEndpointConfiguration(type);

        if (conf && typeof conf === "object") {
            return conf.nesting || null;
        }
    }

    /**
     * Is this endpoint using connector cache
     * @param {string} type Name of the endpoint
     * @returns {boolean} True if the endpoint use cache
     */
    private useCache(type:string):boolean {
        let conf:string|EndpointConfig = this.getEndpointConfiguration(type);

        if (conf && typeof conf === "object") {
            return !!conf.cached;
        }

        return false;
    }

    /**
     * Get optional keys excluded for saving entities in this endpoint
     * @param {string} type Endpoint name
     * @returns {string[]} A list of string keys
     */
    private getExclusions(type:string):string[] {
        let conf:string|EndpointConfig = this.getEndpointConfiguration(type);

        if (conf && typeof conf === "object") {
            return conf.exclusions ? conf.exclusions : [];
        }

        return [];
    }

    /**
     * Get the observable associated to an entity from the store
     * @param {string} type Endpoint name
     * @param {number} id Id of the entity
     * @returns {Observable<DataEntity>} The observable associated to the entity
     */
    private getEntityObservableInStore(type:string, id:number):Observable<DataEntity> {

        if (this.entitiesLiveStore[type]) {
            return this.entitiesLiveStore[type].getEntityObservable(id);
        }

        return null;
    }

    /**
     * Get the observable associated to the collection from the store
     * @param {string} type Endpoint name
     * @param {FilterData} filter Filter object
     * @returns {Observable<DataCollection>} The observable associated to the collection
     */
    private getCollectionObservableInStore(type:string, filter:FilterData):Observable<DataCollection> {
        if (this.collectionsLiveStore[type]) {
            return this.collectionsLiveStore[type].getCollectionSubject(filter);
        }

        return null;
    }

    /**
     * Get the observable associated to an entity from the store, if the store is undefined, create it
     * @param {string} type Endpoint name
     * @param {number} id Id of the entity
     * @returns {Observable<DataEntity>} The observable associated to the entity
     */
    private getEntitySubject(type:string, id:number):ReplaySubject<DataEntity> {

        if (!this.entitiesLiveStore[type]) {
            this.entitiesLiveStore[type] = new EntityStore();
        }

        return this.entitiesLiveStore[type].getEntityObservable(id);
    }

    /**
     * Register entity in the stores
     * @param {string} type Endpoint name
     * @param {number} id Id of the entity
     * @param {DataEntity} entity Entity
     * @param {Observable<DataEntity>} entityObservable Observable to register
     * @returns {Observable<DataEntity>} The observable associated to the entity
     */
    private registerEntity(type:string, id:number, entity:DataEntity, entityObservable:Observable<DataEntity>):Observable<DataEntity> {

        if (!this.entitiesLiveStore[type]) {
            this.entitiesLiveStore[type] = new EntityStore();
        }

        if (!this.collectionsLiveStore[type]) {
            this.collectionsLiveStore[type] = new CollectionStore();
        }

        this.collectionsLiveStore[entity.type].registerEntityInCollections(entity, entityObservable);
        return this.entitiesLiveStore[type].registerEntity(entity, id);
    }

    /**
     *
     * @param {string} type
     * @param {DataCollection} collection
     * @returns {Observable<DataEntity>[]}
     */
    private registerCollectionEntities(type:string, collection:DataCollection):Observable<DataEntity>[] {

        if (!this.entitiesLiveStore[type]) {
            this.entitiesLiveStore[type] = new EntityStore();
        }

        if (!this.collectionsLiveStore[type]) {
            this.collectionsLiveStore[type] = new CollectionStore();
        }

        let entitiesObservables:Observable<DataEntity>[] = [];

        collection.entities.forEach((entity:DataEntity) => {

            let entityObservable:Observable<DataEntity> = this.getEntitySubject(type, entity.id);

            this.collectionsLiveStore[entity.type].registerEntityInCollections(entity, entityObservable, false);
            entitiesObservables.push(this.entitiesLiveStore[type].registerEntity(entity, entity.id));
        });

        return entitiesObservables;
    }

    /**
     * Associate an entity suject the the entity in the entity store
     * @param {string} type Endpoint name
     * @param {number} id Id of the entity
     * @param {ReplaySubject<DataEntity>} subject Subject to associate
     */
    private registerEntitySubject(type:string, id:number, subject:ReplaySubject<DataEntity>) {

        if (!this.entitiesLiveStore[type]) {
            this.entitiesLiveStore[type] = new EntityStore();
        }

        this.entitiesLiveStore[type].registerEntitySubject(id, subject);
    }

    /**
     * Get observable associated to the collection from the store. If store is undefined, create it
     * @param {string} type Endpoint name
     * @param {FilterData} filter Filter object
     * @returns {Observable<DataCollection>} Observable associated to the collection
     */
    private getCollectionObservable(type:string, filter:FilterData):ReplaySubject<DataCollection> {

        if (!this.collectionsLiveStore[type]) {
            this.collectionsLiveStore[type] = new CollectionStore();
        }

        return this.collectionsLiveStore[type].getCollectionSubject(filter);
    }

    /**
     * Register the collection and collection entities in the store
     * @param {string} type Endpoint name
     * @param {FilterData} filter Filter object
     * @param {DataCollection} collection Collection to register
     * @param {boolean} refresh
     * @returns {Observable<DataCollection>} The observable associated to the collection
     */
    private registerCollection(type:string, filter:FilterData, collection:DataCollection, refresh:boolean = true):Observable<DataCollection> {

        if (!this.collectionsLiveStore[type]) {
            this.collectionsLiveStore[type] = new CollectionStore();
        }

        collection.entitiesObservables = this.registerCollectionEntities(type, collection);

        let obs:Observable<DataCollection> = this.collectionsLiveStore[type].registerCollection(collection, filter);

        // refresh de la collection
        if (refresh) {
            this.collectionsLiveStore[type].refreshCollections(filter);
        }

        return obs;
    }

    /**
     * Authenticate to the service
     * @param {string} serviceName Name of service on which we authenticate
     * @param {string} login User login
     * @param {string} password User password
     */
    authenticate(serviceName:string, login:string, password:string) {
        let selectedInterface:ExternalInterface = this.interfaces[serviceName];
        selectedInterface.authenticate(login, password);
    }

    /**
     * Release endpoint if not used
     * @param {string} type Endpoint name
     */
    release(type:string) {

    }

    /**
     * Load entity in specified endpoint
     * @param {string} type Endpoint name
     * @param {number} id Entity id
     * @returns {Observable<DataEntity>} DataEntity observable associated to this entity
     */
    loadEntity(type:string, id:number):Observable<DataEntity> {

        if (this.useCache(type)) {
            let obs:Observable<DataEntity> = this.getEntityObservableInStore(type, id);

            if (obs) {
                return obs;
            }
        }

        let selectedInterface:ExternalInterface = this.getInterface(type);

        let count:number = 0;

        let entityData:EntityDataSet|Observable<EntityDataSet>;

        if (selectedInterface) {

            let entitySubject:ReplaySubject<DataEntity> = this.getEntitySubject(type, id);
            let structure:ModelSchema = this.getEndpointStructureModel(type);

            let checkResponse:Function = () => {
                if (entityData instanceof Observable) {
                    entityData.subscribe((entity:EntityDataSet) => {

                        if (entity) {
                            if (structure) {
                                entity = structure.filterModel(entity);
                            }

                            // hasNesting ?
                            let nested:{[key:string]:string} = this.getNesting(type);

                            this.registerEntity(type, id, new DataEntity(type, entity, this, id), entitySubject);
                        }

                    });
                } else {

                    if (entityData) {
                        if (structure) {
                            entityData = structure.filterModel(entityData);
                        }

                        let newEntity:DataEntity = new DataEntity(type, entityData, this, id);

                        // hasNesting ?
                        let nested:{[key:string]:string} = this.getNesting(type);

                        if (nested) {
                            let nestedKeys:string[] = Object.keys(nested);

                            nestedKeys.forEach((key:string) => {
                                let nestedObservables:Observable<DataEntity>[] = [];

                                if (entityData[key] !== undefined && typeof entityData[key] === "number") {
                                    this.loadEntity(nested[key], entityData[key]).subscribe((loadedEntity:DataEntity) => {
                                        newEntity.nesting[key] = loadedEntity;
                                    });
                                }

                                if (entityData[key] !== undefined && Array.isArray(entityData[key])) {
                                    this.loadEntities(nested[key], entityData[key]).subscribe((loadedEntities:DataEntity[]) => {
                                        newEntity.nesting[key] = loadedEntities;
                                    });
                                }
                            });
                        }

                        this.registerEntity(type, id, newEntity, entitySubject);
                    }

                }
            };

            let errorHandler:Function = (error:InterfaceError) => {
                let msg:string = `Error loading entity of type '${type}' with id ${id}. Error ${error.code}`;
                console.warn(msg);
                error.message = msg;

                if (error.code > 0) {
                    entitySubject.error(error);
                    this.entitiesLiveStore[type].unregister(id);
                } else {

                    if (count < this.maxRetry) {
                        setTimeout(() => {
                            entityData = selectedInterface.loadEntity(type, id, errorHandler);
                            checkResponse();
                        }, this.retryTimeout);

                        count++;
                    } else {
                        entitySubject.error(error);
                        this.entitiesLiveStore[type].unregister(id);
                    }
                }

            };

            entityData = selectedInterface.loadEntity(type, id, errorHandler);
            checkResponse();

            return entitySubject;
        }
    }

    /**
     * Load many entities
     * @param {string} type Endpoint name
     * @param {number[]} ids Entities ids array
     * @returns {Observable<DataEntity[]>} The data entities
     */
    loadEntities(type:string, ids:number[]):Observable<DataEntity[]> {

        // TODO: check si une méthode loadEntities optimisée existe dans l'interface

        let observables:Observable<DataEntity>[] = [];

        ids.forEach((id:number) => {
           observables.push(this.loadEntity(type, id));
        });

        return Observable.combineLatest(...observables);
    }

    /**
     * Load collection from specified endpoint
     * @param {string} type Endpoint name
     * @param {FilterData} filter Filter object
     * @returns {Observable<DataCollection>} Observable associated to this collection
     */
    loadCollection(type:string, filter:FilterData = {}):Observable<DataCollection> {

        if (this.useCache(type)) {
            let obs:Observable<DataCollection> = this.getCollectionObservableInStore(type, filter);

            if (obs) {
                return obs;
            }
        }

        let selectedInterface:ExternalInterface = this.getInterface(type);
        let structure:ModelSchema = this.getEndpointStructureModel(type);

        let count:number = 0;

        if (selectedInterface) {
            let collectionSubject:ReplaySubject<DataCollection> = this.getCollectionObservable(type, filter);
            let collection:CollectionDataSet|Observable<CollectionDataSet>;

            let checkResponse:Function = () => {
                if (collection instanceof Observable) {

                    // attention, dans le cas de nodeJs, on ne doit pas faire de take(1)
                    collection.subscribe((newCollection:CollectionDataSet) => {
                        this.registerCollection(type, filter, new DataCollection(type, newCollection, this, structure));
                    });
                } else {
                    this.registerCollection(type, filter, new DataCollection(type, collection, this, structure));
                }
            };

            let errorHandler:Function = (error:InterfaceError) => {
                let msg:string = `Error loading collection of type '${type}'`;
                console.warn(msg);
                error.message = msg;

                if (error.code > 0) {
                    collectionSubject.error(error);
                    this.collectionsLiveStore[type].unregister(filter);
                } else {
                    if (count < this.maxRetry) {
                        setTimeout(() => {
                            collection = selectedInterface.loadCollection(type, filter, errorHandler);
                            checkResponse();
                        }, this.retryTimeout);

                        count++;
                    } else {
                        collectionSubject.error(error);
                        this.collectionsLiveStore[type].unregister(filter);
                    }
                }

            };

            collection = selectedInterface.loadCollection(type, filter, errorHandler);
            checkResponse();

            return collectionSubject;
        }

        return null;
    }

    /**
     * Save entity
     * @param {DataEntity} entity Entity to save
     * @returns {Observable<DataEntity>} Observable associated to the entity
     */
    saveEntity(entity:DataEntity):Observable<DataEntity> {

        let selectedInterface:ExternalInterface = this.getInterface(entity.type);
        let structure:ModelSchema = this.getEndpointStructureModel(entity.type);

        let dataToSave:EntityDataSet;

        if (selectedInterface.useDiff) {
            dataToSave = entity.getDiff();
        } else {
            dataToSave = entity.getClone();
        }

        let exclusions:string[] = this.getExclusions(entity.type);

        exclusions.forEach((key:string) => {
            if (dataToSave[key]) {
                delete dataToSave[key];
            }
        });

        let entitySubject:ReplaySubject<DataEntity> = this.getEntitySubject(entity.type, entity.id);
        let count:number = 0;

        let entityData:EntityDataSet|Observable<EntityDataSet>;

        let checkResponse:Function = () => {
            if (entityData instanceof Observable) {
                entityData.subscribe((saveEntity:EntityDataSet) => {

                    if (structure) {
                        saveEntity = structure.filterModel(saveEntity);
                    }

                    this.registerEntity(entity.type, entity.id, new DataEntity(entity.type, saveEntity, this, entity.id), entitySubject);
                });
            } else {

                if (structure) {
                    entityData = structure.filterModel(entityData);
                }

                this.registerEntity(entity.type, entity.id, new DataEntity(entity.type, entityData, this, entity.id), entitySubject);
            }
        };

        let errorHandler:Function = (error:InterfaceError) => {
            let msg:string = `Error saving entity of type '${entity.type}' with id ${entity.id}`;
            console.warn(msg);

            error.message = msg;

            if (error.code > 0) {
                entitySubject.error(error);
                this.entitiesLiveStore[entity.type].unregister(entity.id);
            } else {
                if (count < this.maxRetry) {
                    setTimeout(() => {
                        entityData = selectedInterface.saveEntity(dataToSave, entity.type, entity.id, errorHandler);
                        checkResponse();
                    }, this.retryTimeout);

                    count++;
                } else {
                    entitySubject.error(error);
                    this.entitiesLiveStore[entity.type].unregister(entity.id);
                }
            }

        };

        entityData = selectedInterface.saveEntity(dataToSave, entity.type, entity.id, errorHandler);
        checkResponse();

        return entitySubject;
    }

    /**
     * Create entity to the specified endpoint service
     * @param {string} type Endpoint name
     * @param {EntityDataSet} data Data used to create the entity
     * @returns {Observable<DataEntity>} The observable associated to this entity
     */
    createEntity(type:string, data:{[key:string]:any} = {}):Observable<DataEntity> {
        let selectedInterface:ExternalInterface = this.getInterface(type);

        let structure:ModelSchema = this.getEndpointStructureModel(type);

        if (structure) {
            data = structure.generateModel(null, data);
        }

        let exclusions:string[] = this.getExclusions(type);

        exclusions.forEach((key:string) => {
            if (data[key]) {
                delete data[key];
            }
        });

        let entitySubject:ReplaySubject<DataEntity> = new ReplaySubject<DataEntity>(1);
        let count:number = 0;

        let entity:EntityDataSet|Observable<EntityDataSet>;

        let checkResponse:Function = () => {
            if (entity instanceof Observable) {
                entity.subscribe((createdEntity:EntityDataSet) => {
                    this.registerEntitySubject(type, createdEntity.id, entitySubject);
                    this.registerEntity(type, createdEntity.id, new DataEntity(type, createdEntity, this, createdEntity.id), entitySubject);
                });
            } else {
                this.registerEntitySubject(type, entity.id, entitySubject);
                this.registerEntity(type, entity.id, new DataEntity(type, entity, this, entity.id), entitySubject);
            }
        };

        let errorHandler:Function = (error:InterfaceError) => {
            let msg = `Error creating entity of type '${type}'`;
            console.warn(msg);

            error.message = msg;

            if (error.code > 0) {
                entitySubject.error(error);
            } else {
                if (count < this.maxRetry) {
                    setTimeout(() => {
                        entity = selectedInterface.createEntity(type, data, errorHandler);
                        checkResponse();
                    }, this.retryTimeout);

                    count++;
                } else {
                    entitySubject.error(error);
                }
            }
        };

        entity = selectedInterface.createEntity(type, data, errorHandler);
        checkResponse();

        return entitySubject;
    }

    /**
     * Creates an entity on the front only (will be saved on the server later)
     * @param {string} type Endpoint type
     * @param {{[p: string]: any}} data Data used to create the entity
     * @returns {Observable<DataEntity>} The observable associated to this entity
     */
    createTemporaryEntity(type:string, data:{[key:string]:any} = {}):Observable<DataEntity> {
        let structure:ModelSchema = this.getEndpointStructureModel(type);

        if (structure) {
            data = structure.generateModel(null, data);
        }

        let entitySubject:ReplaySubject<DataEntity> = new ReplaySubject<DataEntity>(1);

        let entity:DataEntity = new DataEntity(type, data, this, -1);

        // pas utile
        //entitySubject.next(entity);

        // attention, pas d'id, car pas de retour du serveur
        this.registerEntitySubject(type, null, entitySubject);
        this.registerEntity(type, null, entity, entitySubject);

        return entitySubject;
    }

    /**
     * Delete an entity
     * @param {DataEntity} entity Entity to delete
     * @returns {Observable<boolean>} True if deletion success
     */
    deleteEntity(entity:DataEntity):Observable<boolean> {
        let selectedInterface:ExternalInterface = this.getInterface(entity.type);

        let subject:ReplaySubject<boolean> = new ReplaySubject<boolean>(1);
        let count:number = 0;

        let checkResponse:Function = () => {
            if (result instanceof Observable) {
                result.subscribe((res:boolean) => {
                    this.unregisterEntity(entity);
                    subject.next(res);
                });
            } else {
                this.unregisterEntity(entity);
                subject.next(result);
            }
        };

        let result:boolean|Observable<boolean>;

        let errorHandler:Function = (error:InterfaceError) => {
            let msg:string = `Error deleting entity if type '${entity.type}' with id ${entity.id}`;
            console.warn(msg);

            error.message = msg;

            if (error.code > 0) {
                subject.error(error);
                this.entitiesLiveStore[entity.type].unregister(entity.id);
            } else {
                if (count < this.maxRetry) {
                    setTimeout(() => {
                        result = selectedInterface.deleteEntity(entity.type, entity.id, errorHandler);
                        checkResponse();
                    }, this.retryTimeout);

                    count++;
                } else {
                    subject.error(error);
                    this.entitiesLiveStore[entity.type].unregister(entity.id);
                }
            }

        };

        result = selectedInterface.deleteEntity(entity.type, entity.id, errorHandler);
        checkResponse();

        return subject;
    }


    /**
     * Delete entity from store
     * @param {DataEntity} entity Entity to delete
     */
    private unregisterEntity(entity:DataEntity) {
        this.collectionsLiveStore[entity.type].deleteEntityFromCollection(entity);
        this.entitiesLiveStore[entity.type].unregisterEntity(entity);
    }

    /**
     * Refresh entity (from refresh service)
     * @param {string} type Endpoint name
     * @param {number} id Entity id
     */
    refreshEntity(type:string, id:number) {
        let selectedInterface:ExternalInterface = this.getInterface(type);

        if (this.entitiesLiveStore[type] && this.entitiesLiveStore[type].isInStore(id)) {
            this.loadEntity(type, id);
        }
    }

    /**
     * Refresh collection (from refresh service)
     * @param {string} type Endpoint name
     * @param {FilterData} filter Collection filter object
     */
    refreshCollection(type:string, filter:FilterData) {
        let selectedInterface:ExternalInterface = this.getInterface(type);

        if (this.collectionsLiveStore[type] && this.collectionsLiveStore[type].isInStore(filter)) {
            this.loadCollection(type, filter);
        }
    }
}