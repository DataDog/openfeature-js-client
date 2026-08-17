import { Channel } from 'node:diagnostics_channel';

type Metadata = Record<string, string>;
type Paradigm = "server" | "client";
type PrimitiveValue = null | boolean | string | number;
type JsonObject = {
	[key: string]: JsonValue;
};
type JsonArray = JsonValue[];
type JsonValue = PrimitiveValue | JsonObject | JsonArray;
type EvaluationContextValue = PrimitiveValue | Date | {
	[key: string]: EvaluationContextValue;
} | EvaluationContextValue[];
type EvaluationContext = {
	/**
	 * A string uniquely identifying the subject (end-user, or client service) of a flag evaluation.
	 * Providers may require this field for fractional flag evaluation, rules, or overrides targeting specific users.
	 * Such providers may behave unpredictably if a targeting key is not specified at flag resolution.
	 */
	targetingKey?: string;
} & Record<string, EvaluationContextValue>;
type FlagValueType = "boolean" | "string" | "number" | "object";
type FlagValue = boolean | string | number | JsonValue;
type ResolutionReason = keyof typeof StandardResolutionReasons | (string & Record<never, never>);
type FlagMetadata = Record<string, string | number | boolean>;
type ResolutionDetails<U> = {
	value: U;
	variant?: string;
	flagMetadata?: FlagMetadata;
	reason?: ResolutionReason;
	errorCode?: ErrorCode;
	errorMessage?: string;
};
type EvaluationDetails<T extends FlagValue> = {
	flagKey: string;
	flagMetadata: Readonly<FlagMetadata>;
} & ResolutionDetails<T>;
declare const StandardResolutionReasons: {
	/**
	 * The resolved value is static (no dynamic evaluation).
	 */
	readonly STATIC: "STATIC";
	/**
	 *  The resolved value was configured statically, or otherwise fell back to a pre-configured value.
	 */
	readonly DEFAULT: "DEFAULT";
	/**
	 * The resolved value was the result of a dynamic evaluation, such as a rule or specific user-targeting.
	 */
	readonly TARGETING_MATCH: "TARGETING_MATCH";
	/**
	 * The resolved value was the result of pseudorandom assignment.
	 */
	readonly SPLIT: "SPLIT";
	/**
	 * The resolved value was retrieved from cache.
	 */
	readonly CACHED: "CACHED";
	/**
	 * The resolved value was the result of the flag being disabled in the management system.
	 */
	readonly DISABLED: "DISABLED";
	/**
	 * The reason for the resolved value could not be determined.
	 */
	readonly UNKNOWN: "UNKNOWN";
	/**
	 * The resolved value is non-authoritative or possibly out of date.
	 */
	readonly STALE: "STALE";
	/**
	 * The resolved value was the result of an error.
	 *
	 * Note: The `errorCode` and `errorMessage` fields may contain additional details of this error.
	 */
	readonly ERROR: "ERROR";
};
declare enum ErrorCode {
	/**
	 * The value was resolved before the provider was ready.
	 */
	PROVIDER_NOT_READY = "PROVIDER_NOT_READY",
	/**
	 * The provider has entered an irrecoverable error state.
	 */
	PROVIDER_FATAL = "PROVIDER_FATAL",
	/**
	 * The flag could not be found.
	 */
	FLAG_NOT_FOUND = "FLAG_NOT_FOUND",
	/**
	 * An error was encountered parsing data, such as a flag configuration.
	 */
	PARSE_ERROR = "PARSE_ERROR",
	/**
	 * The type of the flag value does not match the expected type.
	 */
	TYPE_MISMATCH = "TYPE_MISMATCH",
	/**
	 * The provider requires a targeting key and one was not provided in the evaluation context.
	 */
	TARGETING_KEY_MISSING = "TARGETING_KEY_MISSING",
	/**
	 * The evaluation context does not meet provider requirements.
	 */
	INVALID_CONTEXT = "INVALID_CONTEXT",
	/**
	 * An error with an unspecified code.
	 */
	GENERAL = "GENERAL"
}
interface Logger {
	error(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	info(...args: unknown[]): void;
	debug(...args: unknown[]): void;
}
interface ManageLogger<T> {
	/**
	 * Sets a logger on this receiver. This logger supersedes to the global logger
	 * and is passed to various components in the SDK.
	 * The logger configured on the global API object will be used for all evaluations,
	 * unless overridden in a particular client.
	 * @template T The type of the receiver
	 * @param {Logger} logger The logger to be used
	 * @returns {T} The receiver (this object)
	 */
	setLogger(logger: Logger): T;
}
declare enum ServerProviderEvents {
	/**
	 * The provider is ready to evaluate flags.
	 */
	Ready = "PROVIDER_READY",
	/**
	 * The provider is in an error state.
	 */
	Error = "PROVIDER_ERROR",
	/**
	 * The flag configuration in the source-of-truth has changed.
	 */
	ConfigurationChanged = "PROVIDER_CONFIGURATION_CHANGED",
	/**
	 * The provider's cached state is no longer valid and may not be up-to-date with the source of truth.
	 */
	Stale = "PROVIDER_STALE"
}
declare enum ClientProviderEvents {
	/**
	 * The provider is ready to evaluate flags.
	 */
	Ready = "PROVIDER_READY",
	/**
	 * The provider is in an error state.
	 */
	Error = "PROVIDER_ERROR",
	/**
	 * The flag configuration in the source-of-truth has changed.
	 */
	ConfigurationChanged = "PROVIDER_CONFIGURATION_CHANGED",
	/**
	 * The context associated with the provider has changed, and the provider has reconciled it's associated state.
	 */
	ContextChanged = "PROVIDER_CONTEXT_CHANGED",
	/**
	 * The context associated with the provider has changed, and the provider has not yet reconciled its associated state.
	 */
	Reconciling = "PROVIDER_RECONCILING",
	/**
	 * The provider's cached state is no longer valid and may not be up-to-date with the source of truth.
	 */
	Stale = "PROVIDER_STALE"
}
type AnyProviderEvent = ServerProviderEvents | ClientProviderEvents;
type EventMetadata = {
	[key: string]: string | boolean | number;
};
type CommonEventDetails = {
	readonly providerName: string;
	/**
	 * @deprecated alias of "domain", use domain instead
	 */
	readonly clientName?: string;
	readonly domain?: string;
};
type CommonEventProps = {
	readonly message?: string;
	readonly metadata?: EventMetadata;
};
type ReadyEvent = CommonEventProps;
type ErrorEvent$1 = CommonEventProps;
type StaleEvent = CommonEventProps;
type ConfigChangeEvent = CommonEventProps & {
	readonly flagsChanged?: string[];
};
type ServerEventMap = {
	[ServerProviderEvents.Ready]: ReadyEvent;
	[ServerProviderEvents.Error]: ErrorEvent$1;
	[ServerProviderEvents.Stale]: StaleEvent;
	[ServerProviderEvents.ConfigurationChanged]: ConfigChangeEvent;
};
type ClientEventMap = {
	[ClientProviderEvents.Ready]: ReadyEvent;
	[ClientProviderEvents.Error]: ErrorEvent$1;
	[ClientProviderEvents.Stale]: StaleEvent;
	[ClientProviderEvents.ConfigurationChanged]: ConfigChangeEvent;
	[ClientProviderEvents.Reconciling]: CommonEventProps;
	[ClientProviderEvents.ContextChanged]: CommonEventProps;
};
type EventContext<U extends Record<string, unknown> = Record<string, unknown>, T extends ServerProviderEvents | ClientProviderEvents = ServerProviderEvents | ClientProviderEvents> = (T extends ClientProviderEvents ? ClientEventMap[T] : T extends ServerProviderEvents ? ServerEventMap[T] : never) & U;
type EventDetails<T extends ServerProviderEvents | ClientProviderEvents = ServerProviderEvents | ClientProviderEvents> = EventContext<Record<string, unknown>, T> & CommonEventDetails;
type EventHandler<T extends ServerProviderEvents | ClientProviderEvents = ServerProviderEvents | ClientProviderEvents> = (eventDetails?: EventDetails<T>) => Promise<unknown> | unknown;
interface ProviderEventEmitter<E extends AnyProviderEvent, AdditionalContext extends Record<string, unknown> = Record<string, unknown>> extends ManageLogger<ProviderEventEmitter<E, AdditionalContext>> {
	emit(eventType: E, context?: EventContext): void;
	addHandler(eventType: AnyProviderEvent, handler: EventHandler): void;
	removeHandler(eventType: AnyProviderEvent, handler: EventHandler): void;
	removeAllHandlers(eventType?: AnyProviderEvent): void;
	getHandlers(eventType: AnyProviderEvent): EventHandler[];
}
type TrackingEventValue = PrimitiveValue | Date | {
	[key: string]: TrackingEventValue;
} | TrackingEventValue[];
type TrackingEventDetails = {
	/**
	 * A numeric value associated with this event.
	 */
	value?: number;
} & Record<string, TrackingEventValue>;
declare enum ServerProviderStatus {
	/**
	 * The provider has not been initialized and cannot yet evaluate flags.
	 */
	NOT_READY = "NOT_READY",
	/**
	 * The provider is ready to resolve flags.
	 */
	READY = "READY",
	/**
	 * The provider is in an error state and unable to evaluate flags.
	 */
	ERROR = "ERROR",
	/**
	 * The provider's cached state is no longer valid and may not be up-to-date with the source of truth.
	 */
	STALE = "STALE",
	/**
	 * The provider has entered an irrecoverable error state.
	 */
	FATAL = "FATAL"
}
declare enum ClientProviderStatus {
	/**
	 * The provider has not been initialized and cannot yet evaluate flags.
	 */
	NOT_READY = "NOT_READY",
	/**
	 * The provider is ready to resolve flags.
	 */
	READY = "READY",
	/**
	 * The provider is in an error state and unable to evaluate flags.
	 */
	ERROR = "ERROR",
	/**
	 * The provider's cached state is no longer valid and may not be up-to-date with the source of truth.
	 */
	STALE = "STALE",
	/**
	 * The provider has entered an irrecoverable error state.
	 */
	FATAL = "FATAL",
	/**
	 * The provider is reconciling its state with a context change.
	 */
	RECONCILING = "RECONCILING"
}
interface ProviderMetadata extends Readonly<Metadata> {
	readonly name: string;
}
interface CommonProvider<S extends ClientProviderStatus | ServerProviderStatus> {
	readonly metadata: ProviderMetadata;
	/**
	 * Represents where the provider is intended to be run. If defined,
	 * the SDK will enforce that the defined paradigm at runtime.
	 */
	readonly runsOn?: Paradigm;
	/**
	 * @deprecated the SDK now maintains the provider's state; there's no need for providers to implement this field.
	 * Returns a representation of the current readiness of the provider.
	 *
	 * _Providers which do not implement this method are assumed to be ready immediately._
	 */
	readonly status?: S;
	/**
	 * An event emitter for ProviderEvents.
	 * @see ProviderEvents
	 */
	events?: ProviderEventEmitter<AnyProviderEvent>;
	/**
	 * A function used to shut down the provider.
	 * Called when this provider is replaced with a new one, or when the OpenFeature is shut down.
	 */
	onClose?(): Promise<void>;
	/**
	 * A function used to setup the provider.
	 * Called by the SDK after the provider is set if the provider's status is NOT_READY.
	 * When the returned promise resolves, the SDK fires the ProviderEvents.Ready event.
	 * If the returned promise rejects, the SDK fires the ProviderEvents.Error event.
	 * Use this function to perform any context-dependent setup within the provider.
	 * @param context
	 */
	initialize?(context?: EvaluationContext): Promise<void>;
	/**
	 * Track a user action or application state, usually representing a business objective or outcome.
	 * @param trackingEventName
	 * @param context
	 * @param trackingEventDetails
	 */
	track?(trackingEventName: string, context: EvaluationContext, trackingEventDetails: TrackingEventDetails): void;
}
interface ClientMetadata {
	/**
	 * @deprecated alias of "domain", use domain instead
	 */
	readonly name?: string;
	readonly domain?: string;
	readonly version?: string;
	readonly providerMetadata: ProviderMetadata;
}
interface HookData<TData = Record<string, unknown>> {
	/**
	 * Sets a value in the hook data store.
	 * @param key The key to store the value under
	 * @param value The value to store
	 */
	set<K extends keyof TData>(key: K, value: TData[K]): void;
	set(key: string, value: unknown): void;
	/**
	 * Gets a value from the hook data store.
	 * @param key The key to retrieve the value for
	 * @returns The stored value, or undefined if not found
	 */
	get<K extends keyof TData>(key: K): TData[K] | undefined;
	get(key: string): unknown;
	/**
	 * Checks if a key exists in the hook data store.
	 * @param key The key to check
	 * @returns True if the key exists, false otherwise
	 */
	has<K extends keyof TData>(key: K): boolean;
	has(key: string): boolean;
	/**
	 * Deletes a value from the hook data store.
	 * @param key The key to delete
	 * @returns True if the key was deleted, false if it didn't exist
	 */
	delete<K extends keyof TData>(key: K): boolean;
	delete(key: string): boolean;
	/**
	 * Clears all values from the hook data store.
	 */
	clear(): void;
}
type HookHints = Readonly<Record<string, unknown>>;
interface HookContext<T extends FlagValue = FlagValue, TData = Record<string, unknown>> {
	readonly flagKey: string;
	readonly defaultValue: T;
	readonly flagValueType: FlagValueType;
	readonly context: Readonly<EvaluationContext>;
	readonly clientMetadata: ClientMetadata;
	readonly providerMetadata: ProviderMetadata;
	readonly logger: Logger;
	readonly hookData: HookData<TData>;
}
interface BeforeHookContext<T extends FlagValue = FlagValue, TData = Record<string, unknown>> extends HookContext<T, TData> {
	context: EvaluationContext;
}
interface BaseHook<T extends FlagValue = FlagValue, TData = Record<string, unknown>, BeforeHookReturn = unknown, HooksReturn = unknown> {
	/**
	 * Runs before flag values are resolved from the provider.
	 * If an EvaluationContext is returned, it will be merged with the pre-existing EvaluationContext.
	 * @param hookContext
	 * @param hookHints
	 */
	before?(hookContext: BeforeHookContext<T, TData>, hookHints?: HookHints): BeforeHookReturn;
	/**
	 * Runs after flag values are successfully resolved from the provider.
	 * @param hookContext
	 * @param evaluationDetails
	 * @param hookHints
	 */
	after?(hookContext: Readonly<HookContext<T, TData>>, evaluationDetails: EvaluationDetails<T>, hookHints?: HookHints): HooksReturn;
	/**
	 * Runs in the event of an unhandled error or promise rejection during flag resolution, or any attached hooks.
	 * @param hookContext
	 * @param error
	 * @param hookHints
	 */
	error?(hookContext: Readonly<HookContext<T, TData>>, error: unknown, hookHints?: HookHints): HooksReturn;
	/**
	 * Runs after all other hook stages, regardless of success or error.
	 * @param hookContext
	 * @param evaluationDetails
	 * @param hookHints
	 */
	finally?(hookContext: Readonly<HookContext<T, TData>>, evaluationDetails: EvaluationDetails<T>, hookHints?: HookHints): HooksReturn;
}
interface ExposureEvent {
	allocation: {
		key: string;
	};
	flag: {
		key: string;
	};
	variant: {
		key: string;
	};
	serial_id?: number;
	subject: {
		id: string;
		attributes: EvaluationContext;
	};
	service?: string;
	rum?: {
		application?: {
			id?: string;
		};
		view?: {
			url?: string;
		};
	};
}
declare enum OperatorType {
	MATCHES = "MATCHES",
	NOT_MATCHES = "NOT_MATCHES",
	GTE = "GTE",
	GT = "GT",
	LTE = "LTE",
	LT = "LT",
	ONE_OF = "ONE_OF",
	NOT_ONE_OF = "NOT_ONE_OF",
	IS_NULL = "IS_NULL",
	SEMVER_EQ = "SEMVER_EQ",
	SEMVER_NEQ = "SEMVER_NEQ",
	SEMVER_LT = "SEMVER_LT",
	SEMVER_LTE = "SEMVER_LTE",
	SEMVER_GT = "SEMVER_GT",
	SEMVER_GTE = "SEMVER_GTE"
}
type NumericOperator = OperatorType.GTE | OperatorType.GT | OperatorType.LTE | OperatorType.LT;
type MatchesCondition = {
	operator: OperatorType.MATCHES;
	attribute: string;
	value: string;
};
type NotMatchesCondition = {
	operator: OperatorType.NOT_MATCHES;
	attribute: string;
	value: string;
};
type OneOfCondition = {
	operator: OperatorType.ONE_OF;
	attribute: string;
	value: string[];
};
type NotOneOfCondition = {
	operator: OperatorType.NOT_ONE_OF;
	attribute: string;
	value: string[];
};
type NumericCondition = {
	operator: NumericOperator;
	attribute: string;
	value: number;
};
type NullCondition = {
	operator: OperatorType.IS_NULL;
	attribute: string;
	value: boolean;
};
type SemverOperator = OperatorType.SEMVER_EQ | OperatorType.SEMVER_NEQ | OperatorType.SEMVER_LT | OperatorType.SEMVER_LTE | OperatorType.SEMVER_GT | OperatorType.SEMVER_GTE;
type SemverCondition = {
	operator: SemverOperator;
	attribute: string;
	value: string;
};
type Condition = MatchesCondition | NotMatchesCondition | OneOfCondition | NotOneOfCondition | NumericCondition | NullCondition | SemverCondition;
interface Rule {
	conditions: Condition[];
}
type VariantType = "BOOLEAN" | "INTEGER" | "NUMERIC" | "STRING" | "JSON";
interface VariantConfiguration {
	key: string;
	value: FlagValue;
}
interface ShardRange {
	start: number;
	end: number;
}
interface Shard {
	salt: string;
	ranges: ShardRange[];
	totalShards: number;
}
interface Split {
	variationKey: string;
	shards: Shard[];
	extraLogging?: Record<string, string>;
	serialId?: number;
}
interface Allocation {
	key: string;
	rules?: Rule[];
	startAt?: Date;
	endAt?: Date;
	splits: Split[];
	doLog?: boolean;
}
interface Flag {
	key: string;
	enabled: boolean;
	variationType: VariantType;
	variations: Record<string, VariantConfiguration>;
	allocations: Allocation[];
}
export interface UniversalFlagConfigurationV1 {
	createdAt: string;
	format: string;
	environment: {
		name: string;
	};
	flags: Record<string, Flag>;
}
type Hook<TData = Record<string, unknown>> = BaseHook<FlagValue, TData, Promise<EvaluationContext | void> | EvaluationContext | void, Promise<void> | void>;
interface Provider extends CommonProvider<ServerProviderStatus> {
	/**
	 * A provider hook exposes a mechanism for provider authors to register hooks
	 * to tap into various stages of the flag evaluation lifecycle. These hooks can
	 * be used to perform side effects and mutate the context for purposes of the
	 * provider. Provider hooks are not configured or controlled by the application author.
	 */
	readonly hooks?: Hook[];
	/**
	 * Resolve a boolean flag and its evaluation details.
	 */
	resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<boolean>>;
	/**
	 * Resolve a string flag and its evaluation details.
	 */
	resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<string>>;
	/**
	 * Resolve a numeric flag and its evaluation details.
	 */
	resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<number>>;
	/**
	 * Resolve and parse an object flag and its evaluation details.
	 */
	resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<T>>;
}
export interface DatadogNodeServerProviderOptions {
	/**
	 * Log experiment exposures
	 */
	exposureChannel: Channel<ExposureEvent>;
	/**
	 * Timeout in milliseconds for provider initialization.
	 * If the configuration is not set within this time, initialization will fail.
	 * @default DEFAULT_INITIALIZATION_TIMEOUT_MS (30000ms / 30 seconds)
	 */
	initializationTimeoutMs?: number;
}
export declare class DatadogNodeServerProvider implements Provider {
	private readonly options;
	readonly metadata: ProviderMetadata;
	readonly runsOn: Paradigm;
	readonly hooks?: Hook[];
	private initController?;
	readonly events: ProviderEventEmitter<ServerProviderEvents>;
	private readonly exposureCache;
	private configuration?;
	constructor(options: DatadogNodeServerProviderOptions);
	/**
	 * Used by dd-source-js
	 */
	getConfiguration(): UniversalFlagConfigurationV1 | undefined;
	/**
	 * Used by dd-source-js
	 */
	setConfiguration(configuration: UniversalFlagConfigurationV1): void;
	/**
	 * Used by dd-source-js
	 */
	setError(error: unknown): void;
	/**
	 * Used by the OpenFeature SDK to set the status based on initialization.
	 * Status of 'PROVIDER_READY' is emitted with a resolved promise.
	 * Status of 'PROVIDER_ERROR' is emitted with a rejected promise.
	 *
	 * Since we aren't loading the configuration in this Provider, we will simulate
	 * loading functionality via InitializationController.
	 * See setConfiguration and setError for more details.
	 */
	initialize(): Promise<void>;
	resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext, _logger: Logger): Promise<ResolutionDetails<boolean>>;
	resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext, _logger: Logger): Promise<ResolutionDetails<string>>;
	resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext, _logger: Logger): Promise<ResolutionDetails<number>>;
	resolveObjectEvaluation<T extends JsonValue>(flagKey: string, defaultValue: T, context: EvaluationContext, _logger: Logger): Promise<ResolutionDetails<T>>;
	private handleExposure;
}

export {};
