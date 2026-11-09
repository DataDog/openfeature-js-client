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
	readonly sdk?: "js-web" | "js-server";
	readonly paradigm?: Paradigm;
	/**
	 * Identifies the OpenFeature framework SDK the client was obtained through.
	 *
	 * This field is only populated when the client is accessed through the
	 * corresponding framework wrapper (e.g. `<OpenFeatureProvider>` for React,
	 * `FeatureFlagService` / the `*FeatureFlag` directives for Angular, or
	 * Nest's `@OpenFeatureClient()` injection). Clients obtained by calling
	 * `OpenFeature.getClient(...)` directly from `@openfeature/web-sdk` or
	 * `@openfeature/server-sdk` will leave `framework` undefined, even when
	 * used inside a framework application.
	 */
	readonly framework?: "react" | "angular" | "nest";
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
type TimeStamp = number & {
	t: "Epoch time";
};
declare const SCHEME = "flag-key-sha256-v1";
type FlagKeyObfuscation = {
	scheme: typeof SCHEME;
	salt: string;
};
declare enum WireType {
	/**
	 * Used for int32, int64, uint32, uint64, sint32, sint64, bool, enum
	 */
	Varint = 0,
	/**
	 * Used for fixed64, sfixed64, double.
	 * Always 8 bytes with little-endian byte order.
	 */
	Bit64 = 1,
	/**
	 * Used for string, bytes, embedded messages, packed repeated fields
	 *
	 * Only repeated numeric types (types which use the varint, 32-bit,
	 * or 64-bit wire types) can be packed. In proto3, such fields are
	 * packed by default.
	 */
	LengthDelimited = 2,
	/**
	 * Start of a tag-delimited aggregate, such as a proto2 group, or a message
	 * in editions with message_encoding = DELIMITED.
	 */
	StartGroup = 3,
	/**
	 * End of a tag-delimited aggregate.
	 */
	EndGroup = 4,
	/**
	 * Used for fixed32, sfixed32, float.
	 * Always 4 bytes with little-endian byte order.
	 */
	Bit32 = 5
}
type Message<TypeName extends string = string> = {
	/**
	 * The fully qualified Protobuf type-name of the message.
	 */
	readonly $typeName: TypeName;
	/**
	 * Unknown fields and extensions stored on the message.
	 */
	$unknown?: UnknownField[] | undefined;
};
type UnknownField = {
	readonly no: number;
	readonly wireType: WireType;
	readonly data: Uint8Array;
};
type Timestamp = Message<"google.protobuf.Timestamp"> & {
	/**
	 * Represents seconds of UTC time since Unix epoch 1970-01-01T00:00:00Z. Must
	 * be between -62135596800 and 253402300799 inclusive (which corresponds to
	 * 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z).
	 *
	 * @generated from field: int64 seconds = 1;
	 */
	seconds: bigint;
	/**
	 * Non-negative fractions of a second at nanosecond resolution. This field is
	 * the nanosecond portion of the duration, not an alternative to seconds.
	 * Negative second values with fractions must still have non-negative nanos
	 * values that count forward in time. Must be between 0 and 999,999,999
	 * inclusive.
	 *
	 * @generated from field: int32 nanos = 2;
	 */
	nanos: number;
};
type Empty = Message<"google.protobuf.Empty"> & {};
type FlagsConfiguration = Message<"datadog.ffe.flagging.ufc.v1.FlagsConfiguration"> & {
	/**
	 * @generated from field: google.protobuf.Timestamp created_at = 1;
	 */
	createdAt?: Timestamp | undefined;
	/**
	 * @generated from field: string environment_name = 2;
	 */
	environmentName: string;
	/**
	 * @generated from field: map<string, datadog.ffe.flagging.ufc.v1.Flag> flags = 3;
	 */
	flags: {
		[key: string]: Flag;
	};
	/**
	 * Interned data referenced by zero-based indexes in conditions. An index must
	 * refer to an element in its corresponding list.
	 *
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.AttributeReference attributes = 4;
	 */
	attributes: AttributeReference[];
	/**
	 * @generated from field: repeated string strings = 5;
	 */
	strings: string[];
	/**
	 * @generated from field: repeated string regexes = 6;
	 */
	regexes: string[];
	/**
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.Version versions = 7;
	 */
	versions: Version[];
	/**
	 * Interned JSON variation values, each a serialized JSON document. Indexed
	 * by Variation.json_string_index.
	 *
	 * JSON values are stored as strings because for some SDKs, our
	 * users want to override the JSON parser or get the variant as a
	 * string they can parse on their own.
	 *
	 * @generated from field: repeated string json_strings = 8;
	 */
	jsonStrings: string[];
	/**
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.Condition conditions = 9;
	 */
	conditions: Condition[];
	/**
	 * Opt-in flag for emitting full flag-evaluation data from SDKs to
	 * Datadog. May contain PII; defaults to false for privacy.
	 *
	 * @generated from field: bool observe_full_evaluation_data = 10;
	 */
	observeFullEvaluationData: boolean;
	/**
	 * Optional evaluator behavior overrides. Evaluators use their hard-coded
	 * defaults when this message or one of its fields is absent.
	 *
	 * @generated from field: datadog.ffe.flagging.ufc.v1.EvaluatorParams evaluator_params = 11;
	 */
	evaluatorParams?: EvaluatorParams | undefined;
};
type EvaluatorParams = Message<"datadog.ffe.flagging.ufc.v1.EvaluatorParams"> & {
	/**
	 * Maximum dependency-edge depth, counted from a root flag at depth zero.
	 * The maximum is inclusive, and zero rejects every dependency edge. Values
	 * must not exceed 255.
	 *
	 * @generated from field: optional uint64 max_dependency_depth = 1;
	 */
	maxDependencyDepth?: bigint | undefined;
};
type Version = Message<"datadog.ffe.flagging.ufc.v1.Version"> & {
	/**
	 * Main version components (usually "major.minor.patch" but can have more/less
	 * parts). Missing components should be treated as "0" for comparison
	 * purposes.
	 *
	 * @generated from field: repeated string components = 1;
	 */
	components: string[];
	/**
	 * @generated from field: repeated string prerelease = 2;
	 */
	prerelease: string[];
};
type Flag = Message<"datadog.ffe.flagging.ufc.v1.Flag"> & {
	/**
	 * The minimum feature level an SDK must support to evaluate this flag.
	 * SDKs that don't support this level must not evaluate the flag and should
	 * report an informative flag-scoped error rather than treat it as absent.
	 *
	 * @generated from field: uint32 minimum_feature_level = 1;
	 */
	minimumFeatureLevel: number;
	/**
	 * @generated from field: datadog.ffe.flagging.ufc.v1.VariationType variation_type = 2;
	 */
	variationType: VariationType;
	/**
	 * Split.variation_index indexes this array.
	 *
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.Variation variations = 3;
	 */
	variations: Variation[];
	/**
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.Allocation allocations = 4;
	 */
	allocations: Allocation[];
};
type Variation = Message<"datadog.ffe.flagging.ufc.v1.Variation"> & {
	/**
	 * Variation key. Index into FlagsConfiguration.strings
	 *
	 * @generated from field: uint32 key_string_index = 1;
	 */
	keyStringIndex: number;
	/**
	 * The populated field must agree with Flag.variation_type.
	 *
	 * @generated from oneof datadog.ffe.flagging.ufc.v1.Variation.value
	 */
	value: {
		/**
		 * Index into FlagsConfiguration.strings
		 *
		 * @generated from field: uint32 string_value_index = 2;
		 */
		value: number;
		case: "stringValueIndex";
	} | {
		/**
		 * @generated from field: int64 integer_value = 3;
		 */
		value: bigint;
		case: "integerValue";
	} | {
		/**
		 * @generated from field: double numeric_value = 4;
		 */
		value: number;
		case: "numericValue";
	} | {
		/**
		 * @generated from field: bool boolean_value = 5;
		 */
		value: boolean;
		case: "booleanValue";
	} | {
		/**
		 * JSON variations may be any valid JSON value, including scalar values.
		 * Index into FlagsConfiguration.json_strings.
		 *
		 * @generated from field: uint32 json_string_index = 6;
		 */
		value: number;
		case: "jsonStringIndex";
	} | {
		case: undefined;
		value?: undefined;
	};
};
type Allocation = Message<"datadog.ffe.flagging.ufc.v1.Allocation"> & {
	/**
	 * @generated from field: string key = 1;
	 */
	key: string;
	/**
	 * Zero-based index into FlagsConfiguration.conditions. Unset means
	 * this allocation matches every subject.
	 *
	 * @generated from field: optional uint32 targeting_condition_index = 2;
	 */
	targetingConditionIndex?: number | undefined;
	/**
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.PartitionKey partition_key = 3;
	 */
	partitionKey: PartitionKey[];
	/**
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.Split splits = 4;
	 */
	splits: Split[];
	/**
	 * Whether an evaluation resolved by this allocation should emit an
	 * exposure event (e.g. for experiments).
	 *
	 * @generated from field: bool log_exposure_event = 5;
	 */
	logExposureEvent: boolean;
	/**
	 * First randomization activation, independent of later allocation edits.
	 *
	 * @generated from field: google.protobuf.Timestamp randomization_activated_at = 6;
	 */
	randomizationActivatedAt?: Timestamp | undefined;
};
type AttributeReference = Message<"datadog.ffe.flagging.ufc.v1.AttributeReference"> & {
	/**
	 * @generated from oneof datadog.ffe.flagging.ufc.v1.AttributeReference.kind
	 */
	kind: {
		/**
		 * @generated from field: google.protobuf.Empty targeting_key = 1;
		 */
		value: Empty;
		case: "targetingKey";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.AttributePath attribute_path = 2;
		 */
		value: AttributePath;
		case: "attributePath";
	} | {
		case: undefined;
		value?: undefined;
	};
};
type AttributePath = Message<"datadog.ffe.flagging.ufc.v1.AttributePath"> & {
	/**
	 * Contains at least one segment and starts with a string.
	 *
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.AttributePathSegment segments = 1;
	 */
	segments: AttributePathSegment[];
};
type AttributePathSegment = Message<"datadog.ffe.flagging.ufc.v1.AttributePathSegment"> & {
	/**
	 * @generated from oneof datadog.ffe.flagging.ufc.v1.AttributePathSegment.kind
	 */
	kind: {
		/**
		 * Index into FlagsConfiguration.strings.
		 *
		 * @generated from field: uint32 object_key_string_index = 1;
		 */
		value: number;
		case: "objectKeyStringIndex";
	} | {
		/**
		 * @generated from field: uint32 array_index = 2;
		 */
		value: number;
		case: "arrayIndex";
	} | {
		case: undefined;
		value?: undefined;
	};
};
type Condition = Message<"datadog.ffe.flagging.ufc.v1.Condition"> & {
	/**
	 * @generated from oneof datadog.ffe.flagging.ufc.v1.Condition.kind
	 */
	kind: {
		/**
		 * Logical AND. True when every referenced condition is
		 * true. Empty ALL is true.
		 *
		 * @generated from field: datadog.ffe.flagging.ufc.v1.ConditionOperands all = 1;
		 */
		value: ConditionOperands;
		case: "all";
	} | {
		/**
		 * Logical OR. True when any referenced condition is true. Empty
		 * ANY is false.
		 *
		 * @generated from field: datadog.ffe.flagging.ufc.v1.ConditionOperands any = 2;
		 */
		value: ConditionOperands;
		case: "any";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.NumericCondition numeric = 3;
		 */
		value: NumericCondition;
		case: "numeric";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.RegexCondition regex = 4;
		 */
		value: RegexCondition;
		case: "regex";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.StringMembershipCondition string_membership = 5;
		 */
		value: StringMembershipCondition;
		case: "stringMembership";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.Sha256MembershipCondition sha256_membership = 6;
		 */
		value: Sha256MembershipCondition;
		case: "sha256Membership";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.AttributePresenceCondition attribute_presence = 7;
		 */
		value: AttributePresenceCondition;
		case: "attributePresence";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.VersionCondition version = 8;
		 */
		value: VersionCondition;
		case: "version";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.StringComparisonCondition string_comparison = 9;
		 */
		value: StringComparisonCondition;
		case: "stringComparison";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.Sha256StringComparisonCondition sha256_string_comparison = 10;
		 */
		value: Sha256StringComparisonCondition;
		case: "sha256StringComparison";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.FlagEvaluationStringMembershipCondition flag_evaluation_string_membership = 11;
		 */
		value: FlagEvaluationStringMembershipCondition;
		case: "flagEvaluationStringMembership";
	} | {
		case: undefined;
		value?: undefined;
	};
};
type FlagEvaluationStringMembershipCondition = Message<"datadog.ffe.flagging.ufc.v1.FlagEvaluationStringMembershipCondition"> & {
	/**
	 * Index into FlagsConfiguration.strings for the flag key.
	 *
	 * @generated from field: uint32 flag_key_string_index = 1;
	 */
	flagKeyStringIndex: number;
	/**
	 * Indices into FlagsConfiguration.strings for expected variant keys.
	 *
	 * @generated from field: repeated uint32 variant_key_string_indexes = 2;
	 */
	variantKeyStringIndexes: number[];
	/**
	 * True negates membership.
	 *
	 * @generated from field: bool negate = 3;
	 */
	negate: boolean;
};
type ConditionOperands = Message<"datadog.ffe.flagging.ufc.v1.ConditionOperands"> & {
	/**
	 * Zero-based indexes into FlagsConfiguration.conditions.
	 *
	 * @generated from field: repeated uint32 condition_indexes = 1;
	 */
	conditionIndexes: number[];
};
type NumericCondition = Message<"datadog.ffe.flagging.ufc.v1.NumericCondition"> & {
	/**
	 * @generated from field: uint32 attribute_index = 1;
	 */
	attributeIndex: number;
	/**
	 * @generated from field: datadog.ffe.flagging.ufc.v1.NumericComparator comparator = 2;
	 */
	comparator: NumericComparator;
	/**
	 * @generated from field: double comparand = 3;
	 */
	comparand: number;
};
type RegexCondition = Message<"datadog.ffe.flagging.ufc.v1.RegexCondition"> & {
	/**
	 * @generated from field: uint32 attribute_index = 1;
	 */
	attributeIndex: number;
	/**
	 * Index into FlagsConfiguration.regexes.
	 *
	 * @generated from field: uint32 regex_index = 2;
	 */
	regexIndex: number;
	/**
	 * True negates the regex match.
	 *
	 * @generated from field: bool negate = 3;
	 */
	negate: boolean;
};
type StringMembershipCondition = Message<"datadog.ffe.flagging.ufc.v1.StringMembershipCondition"> & {
	/**
	 * @generated from field: uint32 attribute_index = 1;
	 */
	attributeIndex: number;
	/**
	 * Indices into FlagsConfiguration.strings. Sorted by referenced value.
	 *
	 * @generated from field: repeated uint32 string_indexes = 2;
	 */
	stringIndexes: number[];
	/**
	 * True negates membership.
	 *
	 * @generated from field: bool negate = 3;
	 */
	negate: boolean;
};
type StringComparisonCondition = Message<"datadog.ffe.flagging.ufc.v1.StringComparisonCondition"> & {
	/**
	 * @generated from field: uint32 attribute_index = 1;
	 */
	attributeIndex: number;
	/**
	 * @generated from field: datadog.ffe.flagging.ufc.v1.StringComparator comparator = 2;
	 */
	comparator: StringComparator;
	/**
	 * Index into FlagsConfiguration.strings.
	 *
	 * @generated from field: uint32 string_index = 3;
	 */
	stringIndex: number;
	/**
	 * True negates the comparator.
	 *
	 * @generated from field: bool negate = 4;
	 */
	negate: boolean;
};
type Sha256StringComparisonCondition = Message<"datadog.ffe.flagging.ufc.v1.Sha256StringComparisonCondition"> & {
	/**
	 * @generated from field: uint32 attribute_index = 1;
	 */
	attributeIndex: number;
	/**
	 * @generated from field: bytes salt = 2;
	 */
	salt: Uint8Array;
	/**
	 * @generated from field: datadog.ffe.flagging.ufc.v1.Sha256StringComparator comparator = 3;
	 */
	comparator: Sha256StringComparator;
	/**
	 * Number of UTF-8 bytes to extract from the start or end. If the attribute
	 * has fewer bytes, or extraction would split a code point, the condition is
	 * false.
	 *
	 * @generated from field: uint32 length = 4;
	 */
	length: number;
	/**
	 * Expected SHA-256(salt || extracted UTF-8 bytes), as raw digest bytes.
	 *
	 * @generated from field: bytes sha256 = 5;
	 */
	sha256: Uint8Array;
	/**
	 * True negates the comparator.
	 *
	 * @generated from field: bool negate = 6;
	 */
	negate: boolean;
};
type Sha256MembershipCondition = Message<"datadog.ffe.flagging.ufc.v1.Sha256MembershipCondition"> & {
	/**
	 * @generated from field: uint32 attribute_index = 1;
	 */
	attributeIndex: number;
	/**
	 * @generated from field: bytes salt = 2;
	 */
	salt: Uint8Array;
	/**
	 * Sorted lexicographically as raw bytes.
	 *
	 * @generated from field: repeated bytes sha256 = 3;
	 */
	sha256: Uint8Array[];
	/**
	 * True negates membership.
	 *
	 * @generated from field: bool negate = 4;
	 */
	negate: boolean;
};
type AttributePresenceCondition = Message<"datadog.ffe.flagging.ufc.v1.AttributePresenceCondition"> & {
	/**
	 * @generated from field: uint32 attribute_index = 1;
	 */
	attributeIndex: number;
	/**
	 * True checks that the attribute is null/absent (is_null); false checks
	 * that it is present/not-null (is_not_null).
	 *
	 * @generated from field: bool expect_null = 2;
	 */
	expectNull: boolean;
};
type VersionCondition = Message<"datadog.ffe.flagging.ufc.v1.VersionCondition"> & {
	/**
	 * @generated from field: uint32 attribute_index = 1;
	 */
	attributeIndex: number;
	/**
	 * @generated from field: datadog.ffe.flagging.ufc.v1.VersionComparator comparator = 2;
	 */
	comparator: VersionComparator;
	/**
	 * Index into FlagsConfiguration.versions.
	 *
	 * @generated from field: uint32 version_index = 3;
	 */
	versionIndex: number;
};
type PartitionKey = Message<"datadog.ffe.flagging.ufc.v1.PartitionKey"> & {
	/**
	 * @generated from oneof datadog.ffe.flagging.ufc.v1.PartitionKey.kind
	 */
	kind: {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.TimePartitionKey time = 1;
		 */
		value: TimePartitionKey;
		case: "time";
	} | {
		/**
		 * @generated from field: datadog.ffe.flagging.ufc.v1.Md5ShardPartitionKey shard_md5 = 2;
		 */
		value: Md5ShardPartitionKey;
		case: "shardMd5";
	} | {
		case: undefined;
		value?: undefined;
	};
};
type TimePartitionKey = Message<"datadog.ffe.flagging.ufc.v1.TimePartitionKey"> & {};
type Md5ShardPartitionKey = Message<"datadog.ffe.flagging.ufc.v1.Md5ShardPartitionKey"> & {
	/**
	 * Includes any separator between the salt and the hashed value; callers
	 * must concatenate salt and attribute_value directly, with no implicit
	 * separator of their own.
	 *
	 * @generated from field: string salt = 1;
	 */
	salt: string;
	/**
	 * Index into FlagsConfiguration.attributes.
	 *
	 * @generated from field: uint32 attribute_index = 2;
	 */
	attributeIndex: number;
	/**
	 * @generated from field: uint64 total_shards = 3;
	 */
	totalShards: bigint;
};
type Split = Message<"datadog.ffe.flagging.ufc.v1.Split"> & {
	/**
	 * Has the same number of elements as the partition key.
	 *
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.PartitionRange ranges = 1;
	 */
	ranges: PartitionRange[];
	/**
	 * @generated from field: uint32 variation_index = 2;
	 */
	variationIndex: number;
	/**
	 * @generated from field: optional int32 serial_id = 3;
	 */
	serialId?: number | undefined;
	/**
	 * @generated from field: datadog.ffe.flagging.ufc.v1.Reason reason = 4;
	 */
	reason: Reason;
	/**
	 * @generated from field: repeated datadog.ffe.flagging.ufc.v1.Feature features = 5;
	 */
	features: Feature[];
};
type Feature = Message<"datadog.ffe.flagging.ufc.v1.Feature"> & {
	/**
	 * @generated from field: string key = 1;
	 */
	key: string;
	/**
	 * @generated from oneof datadog.ffe.flagging.ufc.v1.Feature.value
	 */
	value: {
		/**
		 * @generated from field: string string_value = 2;
		 */
		value: string;
		case: "stringValue";
	} | {
		/**
		 * @generated from field: double number_value = 3;
		 */
		value: number;
		case: "numberValue";
	} | {
		/**
		 * @generated from field: bool bool_value = 4;
		 */
		value: boolean;
		case: "boolValue";
	} | {
		case: undefined;
		value?: undefined;
	};
	/**
	 * Open strings such as HOOK, EXPOSURE or EVALUATION, not an enum: SDKs ignore destinations
	 * they do not know.
	 *
	 * @generated from field: repeated string destinations = 5;
	 */
	destinations: string[];
};
type PartitionRange = Message<"datadog.ffe.flagging.ufc.v1.PartitionRange"> & {
	/**
	 * @generated from field: optional uint64 from = 1;
	 */
	from?: bigint | undefined;
	/**
	 * @generated from field: optional uint64 to = 2;
	 */
	to?: bigint | undefined;
};
declare enum VariationType {
	/**
	 * @generated from enum value: VARIATION_TYPE_UNSPECIFIED = 0;
	 */
	UNSPECIFIED = 0,
	/**
	 * @generated from enum value: VARIATION_TYPE_STRING = 1;
	 */
	STRING = 1,
	/**
	 * @generated from enum value: VARIATION_TYPE_INTEGER = 2;
	 */
	INTEGER = 2,
	/**
	 * @generated from enum value: VARIATION_TYPE_NUMERIC = 3;
	 */
	NUMERIC = 3,
	/**
	 * @generated from enum value: VARIATION_TYPE_BOOLEAN = 4;
	 */
	BOOLEAN = 4,
	/**
	 * @generated from enum value: VARIATION_TYPE_JSON = 5;
	 */
	JSON = 5
}
declare enum NumericComparator {
	/**
	 * @generated from enum value: NUMERIC_COMPARATOR_UNSPECIFIED = 0;
	 */
	UNSPECIFIED = 0,
	/**
	 * @generated from enum value: NUMERIC_COMPARATOR_LESS_THAN = 1;
	 */
	LESS_THAN = 1,
	/**
	 * @generated from enum value: NUMERIC_COMPARATOR_LESS_THAN_OR_EQUAL = 2;
	 */
	LESS_THAN_OR_EQUAL = 2,
	/**
	 * @generated from enum value: NUMERIC_COMPARATOR_GREATER_THAN = 3;
	 */
	GREATER_THAN = 3,
	/**
	 * @generated from enum value: NUMERIC_COMPARATOR_GREATER_THAN_OR_EQUAL = 4;
	 */
	GREATER_THAN_OR_EQUAL = 4
}
declare enum StringComparator {
	/**
	 * @generated from enum value: STRING_COMPARATOR_UNSPECIFIED = 0;
	 */
	UNSPECIFIED = 0,
	/**
	 * @generated from enum value: STRING_COMPARATOR_STARTS_WITH = 1;
	 */
	STARTS_WITH = 1,
	/**
	 * @generated from enum value: STRING_COMPARATOR_ENDS_WITH = 2;
	 */
	ENDS_WITH = 2,
	/**
	 * @generated from enum value: STRING_COMPARATOR_CONTAINS = 3;
	 */
	CONTAINS = 3
}
declare enum Sha256StringComparator {
	/**
	 * @generated from enum value: SHA256_STRING_COMPARATOR_UNSPECIFIED = 0;
	 */
	UNSPECIFIED = 0,
	/**
	 * @generated from enum value: SHA256_STRING_COMPARATOR_STARTS_WITH = 1;
	 */
	STARTS_WITH = 1,
	/**
	 * @generated from enum value: SHA256_STRING_COMPARATOR_ENDS_WITH = 2;
	 */
	ENDS_WITH = 2
}
declare enum VersionComparator {
	/**
	 * @generated from enum value: VERSION_COMPARATOR_UNSPECIFIED = 0;
	 */
	UNSPECIFIED = 0,
	/**
	 * @generated from enum value: VERSION_COMPARATOR_EQUAL = 1;
	 */
	EQUAL = 1,
	/**
	 * @generated from enum value: VERSION_COMPARATOR_NOT_EQUAL = 2;
	 */
	NOT_EQUAL = 2,
	/**
	 * @generated from enum value: VERSION_COMPARATOR_LESS_THAN = 3;
	 */
	LESS_THAN = 3,
	/**
	 * @generated from enum value: VERSION_COMPARATOR_LESS_THAN_OR_EQUAL = 4;
	 */
	LESS_THAN_OR_EQUAL = 4,
	/**
	 * @generated from enum value: VERSION_COMPARATOR_GREATER_THAN = 5;
	 */
	GREATER_THAN = 5,
	/**
	 * @generated from enum value: VERSION_COMPARATOR_GREATER_THAN_OR_EQUAL = 6;
	 */
	GREATER_THAN_OR_EQUAL = 6
}
declare enum Reason {
	/**
	 * @generated from enum value: REASON_UNSPECIFIED = 0;
	 */
	UNSPECIFIED = 0,
	/**
	 * @generated from enum value: REASON_TARGETING_MATCH = 1;
	 */
	TARGETING_MATCH = 1,
	/**
	 * @generated from enum value: REASON_SPLIT = 2;
	 */
	SPLIT = 2,
	/**
	 * @generated from enum value: REASON_STATIC = 3;
	 */
	STATIC = 3,
	/**
	 * @generated from enum value: REASON_DEFAULT = 4;
	 */
	DEFAULT = 4
}
interface OptOutInstant {
	readonly seconds: number;
	readonly fraction: string;
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
type SemVerOperator = OperatorType.SEMVER_EQ | OperatorType.SEMVER_NEQ | OperatorType.SEMVER_GTE | OperatorType.SEMVER_GT | OperatorType.SEMVER_LTE | OperatorType.SEMVER_LT;
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
type FlagEvaluation = {
	key: string;
};
type FlagEvaluationCondition = {
	operator: OperatorType.ONE_OF | OperatorType.NOT_ONE_OF;
	flagEvaluation: FlagEvaluation;
	value: string[];
};
type NumericCondition$1 = {
	operator: NumericOperator;
	attribute: string;
	value: number;
};
type NullCondition = {
	operator: OperatorType.IS_NULL;
	attribute: string;
	value: boolean;
};
type SemVerCondition = {
	operator: SemVerOperator;
	attribute: string;
	value: string;
};
type Condition$1 = MatchesCondition | NotMatchesCondition | OneOfCondition | NotOneOfCondition | FlagEvaluationCondition | NumericCondition$1 | NullCondition | SemVerCondition;
interface Rule {
	conditions: Condition$1[];
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
interface Split$1 {
	variationKey: string;
	shards: Shard[];
	extraLogging?: Record<string, string>;
	serialId?: number;
	features?: unknown;
}
interface Allocation$1 {
	key: string;
	rules?: Rule[];
	startAt?: Date;
	endAt?: Date;
	randomizationActivatedAt?: string;
	splits: Split$1[];
	/** Required by the UFC JSON schema; the producer always supplies an explicit boolean. */
	doLog: boolean;
}
interface Flag$1 {
	key: string;
	enabled: boolean;
	variationType: VariantType;
	variations: Record<string, VariantConfiguration>;
	allocations: Allocation$1[];
}
export interface UniversalFlagConfigurationV1 {
	createdAt: string;
	format: string;
	observeFullEvaluationData?: boolean;
	evaluatorParams?: {
		maxDependencyDepth?: number;
	};
	environment: {
		name: string;
	};
	flags: Record<string, Flag$1>;
}
type RandomizationActivation = {
	kind: "missing";
} | {
	kind: "valid";
	instant: OptOutInstant;
} | {
	kind: "invalid";
};
type PreparedAllocations<T> = {
	/** False when any activation is invalid, including on unreachable allocations. */
	readonly valid: boolean;
	readonly allocations: ReadonlyArray<{
		allocation: T;
		activation: RandomizationActivation;
	}>;
};
type CachedJsonValue = {
	valid: true;
	value: FlagValue;
} | {
	valid: false;
};
type PreparedRulesResponse = FlagsConfiguration & {
	evaluationRegexCache: Map<number, RegExp | null>;
	evaluationJsonCache: Map<number, CachedJsonValue>;
	/** Validated once at decode time; evaluation must not read raw activation timestamps. */
	randomizationActivations: ReadonlyMap<Flag, PreparedAllocations<Allocation>>;
};
/**
 * Internal flags configuration for DatadogProvider.
 */
type FlagsConfiguration$1 = {
	/** The configuration wire could not be parsed, so no capability was decoded. @internal */
	configurationError?: string;
	/** @internal */
	precomputed?: PrecomputedConfiguration;
	/** The precomputed capability could not be decoded; a valid rules capability remains usable. @internal */
	precomputedError?: string;
	/** @internal */
	rules?: RulesConfiguration;
	/** The rules capability could not be decoded; a valid precomputed capability remains usable. @internal */
	rulesError?: string;
};
type PrecomputedConfiguration = {
	response: PrecomputedConfigurationResponse;
	context?: EvaluationContext;
	fetchedAt?: TimeStamp;
	etag?: string;
	/** Parsing errors for malformed flags, retained by flag key. */
	flagErrors?: Record<string, string>;
};
type RulesConfiguration = {
	response: PreparedRulesResponse;
	fetchedAt?: TimeStamp;
	etag?: string;
};
type FlagTypeToValue<T extends FlagValueType> = {
	boolean: boolean;
	string: string;
	number: number;
	object: JsonValue;
}[T];
type PrecomputedConfigurationResponse = {
	data: {
		attributes: {
			/** When configuration was generated. */
			createdAt: string;
			format?: "PRECOMPUTED";
			environment?: {
				name: string;
			};
			observeFullEvaluationData?: boolean;
			/** Effective server evaluation options, retained in portable and persisted configurations. */
			evaluation_options?: {
				experimentation_opt_out?: boolean;
				experimentation_opt_out_mode?: string;
				dd_experimentation_opt_out_at?: string;
			};
			/** Absent or false for legacy plaintext assignments. */
			obfuscated?: boolean;
			/** Required when obfuscated is true; retained with the map in caches. */
			obfuscation?: FlagKeyObfuscation;
			flags: Record<string, PrecomputedFlag>;
		};
	};
};
type PrecomputedFlag<T extends FlagValueType = FlagValueType> = {
	allocationKey: string;
	variationKey: string;
	variationType: T;
	variationValue: FlagTypeToValue<T>;
	reason: ResolutionReason;
	doLog: boolean;
	serialId?: number | null;
	/** Split features of the selected assignment; parsed leniently at evaluation time. */
	features?: unknown;
};
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
	features?: Record<string, string | number | boolean>;
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
/** Response formats a target client can read. Plaintext is always supported. */
export type PrecomputedClientCompatibility = {
	readonly capabilities: readonly string[];
};
/**
 * Return a detached copy of the context from a precomputed configuration.
 *
 * This function returns `undefined` when the configuration has no
 * context-specific precomputed branch. It does not modify the configuration,
 * OpenFeature, or provider state.
 */
export declare function getPrecomputedContext(configuration: FlagsConfiguration$1): EvaluationContext | undefined;
export type FlagsConfigurationWire = string;
/**
 * Parse the precomputed entry from an opaque flags configuration wire value.
 */
declare function configurationFromPrecomputedString(wire: FlagsConfigurationWire): FlagsConfiguration$1;
/**
 * Serialize only the precomputed capability of a flags configuration.
 */
declare function configurationToPrecomputedString(configuration: FlagsConfiguration$1): FlagsConfigurationWire;
type DependencyEvaluation = {
	flagKey: string;
	details: Omit<ResolutionDetails<FlagValue>, "value"> & {
		value?: FlagValue;
	};
};
export type ConfigurationFetchErrorCode = "invalid_options" | "http" | "invalid_response" | "decode" | "transport" | "cancelled" | "timeout";
/** A configuration-loading failure, not an OpenFeature evaluation error. */
export declare class ConfigurationFetchError extends Error {
	readonly code: ConfigurationFetchErrorCode;
	readonly status?: number | undefined;
	constructor(code: ConfigurationFetchErrorCode, message: string, status?: number | undefined);
}
interface ConfigurationTransportOptions {
	/** Request and response-body deadline in milliseconds. Defaults to 5000. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Fetch-compatible transport. Must honor the supplied signal and redirect policy. */
	fetch?: typeof globalThis.fetch;
}
export interface PrecomputedConfigurationFetchOptions extends ConfigurationTransportOptions {
	/** Required for now. Only client-distributed flags are supported by this endpoint. */
	distributionChannel: "client";
	clientToken: string;
	apiKey?: never;
	env: string;
	/** Datadog site. Defaults to datadoghq.com. */
	site?: string;
	applicationId?: string;
	context: EvaluationContext;
	/** Target client's response support, not the fetching Node SDK's capabilities. */
	clientCompatibility?: PrecomputedClientCompatibility;
}
/** Fetch assignments for one client context, without initializing a provider or emitting tracking events. */
export declare function fetchPrecomputedConfiguration(options: PrecomputedConfigurationFetchOptions): Promise<FlagsConfiguration$1>;
export declare enum ExperimentationOptOutMode {
	Disabled = "disabled",
	Immediate = "immediate"
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
	 * Internal sidecar consumed by the integration's root evaluation hook.
	 * @internal
	 */
	dependencyTelemetrySidecar?: DependencyTelemetrySidecar;
	/**
	 * Timeout in milliseconds for provider initialization.
	 * If the configuration is not set within this time, initialization will fail.
	 * @default DEFAULT_INITIALIZATION_TIMEOUT_MS (30000ms / 30 seconds)
	 */
	initializationTimeoutMs?: number;
	/** Experiment exclusion policy. Defaults to Disabled; environment configuration belongs to the caller. */
	experimentationOptOutMode?: ExperimentationOptOutMode;
}
type PreparedDependencyExposure = {
	details: Omit<EvaluationDetails<FlagValue>, "value"> & {
		value?: FlagValue;
	};
	event: ExposureEvent;
};
type PreparedDependencyTelemetry = {
	dependencyEvaluations: readonly DependencyEvaluation[];
	dependencyExposures: readonly PreparedDependencyExposure[];
};
/**
 * Associates a completed dependency trace with the root result's metadata and evaluation context.
 * Evaluation and exposure hooks consume their respective batches from the same root lifecycle.
 * @internal
 */
export declare class DependencyTelemetrySidecar {
	readonly collectDependencyEvaluations: boolean;
	private readonly batchesByMetadata;
	private readonly batchesByContext;
	constructor(collectDependencyEvaluations?: boolean);
	stage(rootMetadata: object, rootContext: object, telemetry: PreparedDependencyTelemetry): void;
	takeDependencyEvaluations(metadata: object | undefined, context?: object): readonly DependencyEvaluation[];
	takeDependencyExposures(metadata: object | undefined): readonly PreparedDependencyExposure[];
	discardDependencyExposures(metadata: object | undefined): void;
	private getBatch;
	private deleteBatch;
}
export declare class DatadogNodeServerProvider implements Provider {
	private readonly options;
	readonly metadata: ProviderMetadata;
	readonly runsOn: Paradigm;
	readonly hooks?: Hook[];
	private initController?;
	readonly events: ProviderEventEmitter<ServerProviderEvents>;
	private readonly exposureCache;
	private readonly dependencyTelemetrySidecar;
	private configuration?;
	private readonly experimentationOptOutMode;
	constructor(options: DatadogNodeServerProviderOptions);
	/**
	 * Used by dd-source-js
	 */
	getConfiguration(): UniversalFlagConfigurationV1 | undefined;
	/**
	 * Used by dd-source-js. Pass null or undefined to withdraw the configuration.
	 */
	setConfiguration(configuration: UniversalFlagConfigurationV1 | null | undefined): void;
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
	private stageDependencyTelemetry;
	/** Prepares a verdict finalized by the provider hook after successful evaluation. */
	private handleExposure;
	private prepareExposure;
}

export {
	FlagsConfiguration$1 as FlagsConfiguration,
	configurationFromPrecomputedString as configurationFromString,
	configurationToPrecomputedString as configurationToString,
};

export {};
