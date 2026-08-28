import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { LoadedConfig } from '../config/loadConfig.js';

// Application
import { GenerationPipeline, type OnStageComplete } from '@application/pipeline/GenerationPipeline.js';
import type { AnyStage } from '@application/pipeline/GenerationPipeline.js';
import { SubmitGenerationJob } from '@application/usecase/SubmitGenerationJob.js';
import { GetJobStatus } from '@application/usecase/GetJobStatus.js';
import { CancelJob } from '@application/usecase/CancelJob.js';
import { ProcessGenerationJob } from '@application/usecase/ProcessGenerationJob.js';
import {
  ValidateInputsStage, ResearchTopicStage, IngestSourcesStage, TranscribeAudioStage,
  ConsolidateContentStage,
  GenerateScriptStage, ReviewStoryPlanStage, ScriptAssembler,
  BuildStoryboardStage, JudgeStoryboardStage, SynthesizeSpeechStage,
  GenerateSubtitlesStage, GenerateQuizStage, RenderFramesStage, AssembleVideoStage,
  PublishArtifactsStage,
} from '@application/pipeline/stage/index.js';
import type { ObjectStoragePort } from '@application/port/ObjectStoragePort.js';
import { JobId } from '@domain/job/JobId.js';
import type { WorkspacePort } from '@application/port/WorkspacePort.js';
import type { JobConsumerPort } from '@application/port/JobConsumerPort.js';

// Infrastructure — the only file in the codebase that names a vendor adapter.
import { BullMqJobQueue } from '@infrastructure/queue/BullMqJobQueue.js';
import { BullMqJobConsumer } from '@infrastructure/queue/BullMqJobConsumer.js';
import { RedisJobRepository } from '@infrastructure/queue/RedisJobRepository.js';
import { SharedVolumeWorkspace } from '@infrastructure/storage/SharedVolumeWorkspace.js';
import { LocalObjectStorage } from '@infrastructure/storage/LocalObjectStorage.js';
import { FfmpegRunner } from '@infrastructure/encode/FfmpegRunner.js';
import { FfmpegAssembler } from '@infrastructure/encode/FfmpegAssembler.js';
import { PlaywrightSceneRenderer } from '@infrastructure/render/PlaywrightSceneRenderer.js';
import { BrowserPool } from '@infrastructure/render/BrowserPool.js';
import { PlaywrightScenePreviewer } from '@infrastructure/render/PlaywrightScenePreviewer.js';
import { DeterministicSceneChecks } from '@infrastructure/judge/DeterministicSceneChecks.js';
import { ExtractorRegistry } from '@infrastructure/extraction/ExtractorRegistry.js';
import { MagicByteSniffer } from '@infrastructure/extraction/TypeSniffer.js';
import { ArchiveGuard } from '@infrastructure/extraction/ArchiveGuard.js';
import { LanguageDetector } from '@infrastructure/extraction/LanguageDetector.js';
import { PdfExtractor } from '@infrastructure/extraction/PdfExtractor.js';
import { PlainTextExtractor } from '@infrastructure/extraction/PlainTextExtractor.js';
import { DocxExtractor } from '@infrastructure/extraction/DocxExtractor.js';
import { PptxExtractor } from '@infrastructure/extraction/PptxExtractor.js';
import { WebPageExtractor } from '@infrastructure/extraction/WebPageExtractor.js';
import { YouTubeExtractor } from '@infrastructure/extraction/YouTubeExtractor.js';
import { AudioFileExtractor } from '@infrastructure/extraction/AudioFileExtractor.js';
import { ImageExtractor } from '@infrastructure/extraction/ImageExtractor.js';
import { SafeHttpClient } from '@infrastructure/http/SafeHttpClient.js';
import { NarrationTextNormalizer } from '@infrastructure/speech/NarrationTextNormalizer.js';
import { CostMeter, DEFAULT_PRICING } from '@infrastructure/observability/CostMeter.js';
import { SystemClock } from '@infrastructure/observability/SystemClock.js';
import { StubScriptGenerator } from '@infrastructure/stub/StubScriptGenerator.js';
import { StubStoryboardGenerator } from '@infrastructure/stub/StubStoryboardGenerator.js';
import { StubSpeechSynthesizer } from '@infrastructure/stub/StubSpeechSynthesizer.js';
import { StubTranscriber } from '@infrastructure/stub/StubTranscriber.js';
import { StubEmbedder } from '@infrastructure/stub/StubEmbedder.js';
import { StubQualityJudge } from '@infrastructure/stub/StubQualityJudge.js';
import { StubVisionReader } from '@infrastructure/stub/StubVisionReader.js';
import { StubQuizGenerator } from '@infrastructure/stub/StubQuizGenerator.js';
import { StubStoryPlanJudge } from '@infrastructure/stub/StubStoryPlanJudge.js';
import { PromptLibrary, type PromptName } from '@infrastructure/llm/PromptLibrary.js';
import { OpenAiClient } from '@infrastructure/llm/OpenAiClient.js';
import { GeminiClient } from '@infrastructure/llm/GeminiClient.js';
import type { LlmClientPort } from '@application/port/LlmClientPort.js';
import { PromptedScriptGenerator } from '@infrastructure/llm/PromptedScriptGenerator.js';
import { PromptedStoryboardGenerator } from '@infrastructure/llm/PromptedStoryboardGenerator.js';
import { PromptedQuizGenerator } from '@infrastructure/llm/PromptedQuizGenerator.js';
import { PromptedVisualPlanner } from '@infrastructure/llm/PromptedVisualPlanner.js';
import { StubVisualPlanner } from '@infrastructure/stub/StubVisualPlanner.js';
import { PromptedQualityJudge } from '@infrastructure/llm/PromptedQualityJudge.js';
import { PromptedStoryPlanJudge } from '@infrastructure/llm/PromptedStoryPlanJudge.js';
import { PromptedVisionReader } from '@infrastructure/llm/PromptedVisionReader.js';
import type { IllustrationFinderPort } from '@application/port/ImageSourcePort.js';
import { CompositeImageSource } from '@infrastructure/image/CompositeImageSource.js';
import { ImageSourceRegistry } from '@infrastructure/image/ImageSourceRegistry.js';
import { GeneratedImageSource } from '@infrastructure/image/GeneratedImageSource.js';
import { GeminiImageGenerator } from '@infrastructure/image/GeminiImageGenerator.js';
import { WebSearchImageSource } from '@infrastructure/image/WebSearchImageSource.js';
import type { WebSearchPort } from '@application/port/WebSearchPort.js';
import { BraveSearchClient, BraveWebSearch } from '@infrastructure/search/BraveSearchClient.js';
import { GeminiGroundedSearch } from '@infrastructure/search/GeminiGroundedSearch.js';
import type { Theme } from '@domain/media/Theme.js';
import { UnsplashImageSource } from '@infrastructure/image/UnsplashImageSource.js';
import { PexelsImageSource } from '@infrastructure/image/PexelsImageSource.js';
import { WikimediaImageSource } from '@infrastructure/image/WikimediaImageSource.js';
import { ElevenLabsSpeechSynthesizer } from '@infrastructure/speech/ElevenLabsSpeechSynthesizer.js';
import { OpenAiSpeechSynthesizer } from '@infrastructure/speech/OpenAiSpeechSynthesizer.js';
import { GeminiSpeechSynthesizer } from '@infrastructure/speech/GeminiSpeechSynthesizer.js';
import { WhisperCliTranscriber } from '@infrastructure/speech/WhisperCliTranscriber.js';
import type { WordAligner } from '@infrastructure/speech/align/WordAligner.js';
import { WhisperCliWordAligner } from '@infrastructure/speech/align/WhisperCliWordAligner.js';
import { OpenAiWordAligner } from '@infrastructure/speech/align/OpenAiWordAligner.js';

export interface Container {
  /** The bounded connection — safe to await on a request path. */
  readonly redis: Redis;
  readonly queue: BullMqJobQueue;
  readonly repository: RedisJobRepository;
  readonly workspace: WorkspacePort;
  readonly storage: ObjectStoragePort;
  readonly submitJob: SubmitGenerationJob;
  readonly getStatus: GetJobStatus;
  readonly cancelJob: CancelJob;
  readonly buildProcessor: (onStageComplete: OnStageComplete) => ProcessGenerationJob;
  /**
   * The composed pipeline stages. Exposed so the worker and the end-to-end
   * runner drive the same list — a second assembly somewhere else would drift
   * from this one and test a pipeline that production does not run.
   */
  readonly stages: readonly AnyStage[];
  /** Built lazily: the API never consumes, so it never pays for the connection. */
  readonly buildConsumer: () => JobConsumerPort;
  readonly sweepOrphans: () => Promise<number>;
  readonly close: () => Promise<void>;
}

/**
 * The composition root. Every adapter is bound to its port here and nowhere else —
 * swapping a provider is one line in this file plus the new adapter, with no
 * change to domain/, application/ or any pipeline stage. An eslint rule keeps
 * vendor imports out of every other file so that stays true.
 */
export function buildContainer(config: LoadedConfig, logger: Logger): Container {
  const { env, resolved } = config;

  /**
   * Two connections, deliberately.
   *
   * BullMQ requires `maxRetriesPerRequest: null` — it manages its own retry and
   * blocking semantics. But that setting means a command issued while Redis is
   * down retries *forever*, which on a request path turns an outage into hung
   * connections rather than a fast 503. So the read path gets its own connection
   * with a bounded command timeout, and only the queue gets BullMQ's.
   */
  const queueConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    commandTimeout: 2000,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  // An unreachable Redis is reported by /health; it must not crash the process.
  redis.on('error', (error) => logger.debug({ err: error }, 'redis connection error'));
  queueConnection.on('error', (error) => logger.debug({ err: error }, 'redis queue connection error'));

  const queue = new BullMqJobQueue(queueConnection, {
    maxAttempts: resolved.jobMaxAttempts,
    maxDepth: config.queue.maxDepth,
  });
  const repository = new RedisJobRepository(redis, resolved);

  /**
   * Published artifacts on the local filesystem, served by the API.
   *
   * There is one driver because there is one deployment target. A hosted bucket
   * is a new adapter behind ObjectStoragePort and one line here — which is the
   * point of the port; carrying an untested S3 implementation for a deployment
   * that does not exist yet is not.
   */
  const storage: ObjectStoragePort = new LocalObjectStorage(env.STORAGE_LOCAL_DIR, env.STORAGE_PUBLIC_BASE_URL);

  /**
   * The job workspace: a compose named volume mounted at the same path in every
   * worker, so a requeued job finds the checkpoint its predecessor wrote.
   */
  const sharedVolume = new SharedVolumeWorkspace(env.WORKSPACE_DIR);
  const workspace: WorkspacePort = sharedVolume;

  const clock = new SystemClock();
  const ffmpeg = new FfmpegRunner();
  const encoder = new FfmpegAssembler(ffmpeg);
  const http = new SafeHttpClient(resolved.input.fetch);
  const detector = new LanguageDetector();

  /**
   * Providers, chosen by driver.
   *
   * Each `stub` runs the pipeline honestly without credentials; each real
   * adapter is a drop-in behind the same port. Switching one is an .env change,
   * which is what makes the provider-swap claim testable rather than asserted.
   */
  /**
   * Attribution for the cost report: which vendor is behind each category.
   * `ffmpeg` and `local` are named rather than left blank because "free" is a
   * price, not an absence of a provider.
   */
  const providerNames = {
    llm: env.LLM_DRIVER,
    tts: env.TTS_DRIVER,
    stt: env.STT_DRIVER,
    rendering: 'playwright',
    storage: 'local',
    embeddings: 'stub',
    // Named even when nothing draws: "images: none" is the answer to "why is
    // every board a photograph", and a blank would not be.
    images: env.IMAGE_GENERATION && env.GEMINI_API_KEY ? env.GEMINI_IMAGE_MODEL : 'none',
    search: env.WEB_SEARCH_DRIVER,
  } as const;

  /**
   * Per-driver price overrides.
   *
   * OpenAI TTS has no native word timings, so its adapter transcribes its own
   * output to recover them — a second, per-minute charge that would otherwise go
   * unbilled and make it look cheaper than ElevenLabs when it is not.
   *
   * Every figure is an estimate until an invoice lands; see DEFAULT_PRICING.
   */
  /**
   * The aligner a synthesiser without native word timings will borrow.
   *
   * Local whisper.cpp first: it is free, and narration audio staying on the
   * machine is the reason STT has no hosted option at all. The OpenAI endpoint
   * is the fallback, and only when that key is already present — adding a second
   * vendor to the data path is a decision, not a default. Neither available
   * means no timings, which the synthesiser reports per scene.
   */
  const aligner: WordAligner | undefined = env.STT_DRIVER === 'whisper'
    ? new WhisperCliWordAligner({
        binaryPath: env.WHISPER_BINARY,
        modelPath: env.WHISPER_MODEL_PATH,
        threads: env.WHISPER_THREADS,
        timeoutMs: env.STT_TIMEOUT_MS,
      }, ffmpeg, logger)
    : env.OPENAI_API_KEY
      ? new OpenAiWordAligner({
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_TTS_ALIGN_MODEL,
          requestTimeoutMs: env.TTS_TIMEOUT_MS,
        }, logger)
      : undefined;

  /**
   * Per-driver price overrides, because "what a minute of narration costs"
   * differs by more than the per-character rate.
   *
   * OpenAI and Gemini both return audio without word timings, so their adapters
   * pay for an alignment pass — but only when that pass is billed. A local
   * whisper aligner costs nothing, and charging for it would put a number in
   * cost.json that no invoice will ever contain.
   */
  const alignmentPerAudioHour = aligner?.name === 'openai' ? 0.36 : 0;

  /**
   * A generated illustration is billed per image, and only when one is drawn —
   * a searched image costs nothing and records nothing, which is what makes the
   * `images` line in cost.json answer "what did generating the pictures cost".
   */
  const imagePerGeneration = env.IMAGE_GENERATION ? DEFAULT_PRICING.imagePerGeneration : 0;
  const pricing = env.TTS_DRIVER === 'openai'
    ? { ...DEFAULT_PRICING, ttsPerMillionChars: 15.0, ttsAlignmentPerAudioHour: 0.36, imagePerGeneration }
    : env.TTS_DRIVER === 'gemini'
      /**
       * Gemini bills TTS per *token*, not per character, so the rate here is
       * derived rather than quoted: $10 per million audio output tokens at
       * ~25 tokens per second of speech, against a measured 68 characters →
       * 4.9 seconds. That is ~$18 per million characters. Text input is a
       * rounding error beside it.
       *
       * An estimate like every figure in DEFAULT_PRICING, and one to re-derive
       * if the audio token rate changes.
       */
      ? {
          ...DEFAULT_PRICING,
          ttsPerMillionChars: 18.0,
          ttsAlignmentPerAudioHour: alignmentPerAudioHour,
          imagePerGeneration,
        }
      : { ...DEFAULT_PRICING, imagePerGeneration };

  const prompts = new PromptLibrary(env.PROMPT_DIR, env.PROMPT_HOT_RELOAD);

  /**
   * Image libraries, enabled by their credentials rather than by a driver flag.
   *
   * With none of them configured the whole `illustration` shape is withdrawn:
   * the script stage stops offering it and the illustrator has no source to ask,
   * so a deployment with no keys behaves exactly as it did before the feature
   * existed. That is the reason presence-of-key is the switch — there is no
   * state where the option is offered and cannot be filled.
   */
  /**
   * Two registries, and the reason is that one of the sources consults the
   * others.
   *
   * `searchRegistry` holds the libraries that go and look something up.
   * `GeneratedImageSource` is built over a finder across *those*, because a
   * drawing grounded on a real published figure is worth far more than one
   * invented from a description — and then it is registered alongside them for
   * the finder the pipeline actually uses. Registering it into the same registry
   * it searches would make it consult itself.
   */
  const searchRegistry = new ImageSourceRegistry();
  if (env.UNSPLASH_ACCESS_KEY) {
    searchRegistry.register('unsplash', new UnsplashImageSource({
      accessKey: env.UNSPLASH_ACCESS_KEY,
      requestTimeoutMs: env.IMAGE_TIMEOUT_MS,
    }, logger));
  }
  if (env.PEXELS_API_KEY) {
    searchRegistry.register('pexels', new PexelsImageSource({
      apiKey: env.PEXELS_API_KEY,
      requestTimeoutMs: env.IMAGE_TIMEOUT_MS,
    }));
  }
  if (env.WIKIMEDIA_IMAGES) {
    searchRegistry.register('wikimedia', new WikimediaImageSource({
      requestTimeoutMs: env.IMAGE_TIMEOUT_MS,
      userAgent: env.IMAGE_USER_AGENT,
    }));
  }

  /**
   * Web search serves two unrelated callers — research and the `web_search`
   * image source — from one credential, so it is built once here.
   *
   * Only Brave can answer both: Gemini's grounding returns pages and never
   * images, which is why an image source is created for one driver and not the
   * other rather than for "whenever search is on".
   */
  const brave = env.WEB_SEARCH_DRIVER === 'brave'
    ? new BraveSearchClient({
        apiKey: requireEnv(env.BRAVE_API_KEY, 'BRAVE_API_KEY'),
        requestTimeoutMs: env.WEB_SEARCH_TIMEOUT_MS,
      })
    : undefined;

  if (brave) {
    searchRegistry.register('web_search', new WebSearchImageSource(brave, {
      requestTimeoutMs: env.IMAGE_TIMEOUT_MS,
    }));
  }

  const imageRegistry = new ImageSourceRegistry();
  for (const id of searchRegistry.registered) {
    imageRegistry.register(id, searchRegistry.resolve(id)!);
  }

  /**
   * Generated boards need an image model, and this one is Gemini's — reachable
   * on the same key as the text models, so a deployment already using
   * LLM_DRIVER=gemini gets it without a second credential. Presence of the key
   * is the switch, exactly as it is for every search library.
   */
  const imageGenerator = env.GEMINI_API_KEY && env.IMAGE_GENERATION
    ? new GeminiImageGenerator({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_IMAGE_MODEL,
        requestTimeoutMs: env.IMAGE_GENERATION_TIMEOUT_MS,
      }, logger)
    : undefined;

  if (imageGenerator) {
    imageRegistry.register('generated', new GeneratedImageSource(
      imageGenerator,
      // The look every generated board shares, composed from the theme so two
      // deployments with different themes cannot produce the same drawing.
      { styleBrief: styleBriefFor(resolved.defaultTheme) },
      logger,
      ...(searchRegistry.isEmpty
        ? []
        : [new CompositeImageSource(searchRegistry, resolved.policies.imageSource, logger)]),
    ));
  }

  const images: IllustrationFinderPort | undefined = imageRegistry.isEmpty
    ? undefined
    : new CompositeImageSource(imageRegistry, resolved.policies.imageSource, logger);

  const webSearch: WebSearchPort | undefined = brave
    ? new BraveWebSearch(brave)
    : env.WEB_SEARCH_DRIVER === 'gemini'
      ? new GeminiGroundedSearch({
          apiKey: requireEnv(env.GEMINI_API_KEY, 'GEMINI_API_KEY'),
          // The volume tier: this call plans searches and returns URLs, and its
          // output is checked by whether the pages exist.
          model: env.GEMINI_MODEL_VOLUME,
          requestTimeoutMs: env.WEB_SEARCH_TIMEOUT_MS,
        }, logger)
      : undefined;

  const llm: LlmClientPort | undefined = env.LLM_DRIVER === 'openai'
    ? new OpenAiClient({
        apiKey: requireEnv(env.OPENAI_API_KEY, 'OPENAI_API_KEY'),
        qualityModel: env.OPENAI_MODEL_QUALITY,
        volumeModel: env.OPENAI_MODEL_VOLUME,
        maxRetries: env.LLM_MAX_RETRIES,
        requestTimeoutMs: env.LLM_TIMEOUT_MS,
      }, logger)
    : env.LLM_DRIVER === 'gemini'
      ? new GeminiClient({
          apiKey: requireEnv(env.GEMINI_API_KEY, 'GEMINI_API_KEY'),
          qualityModel: env.GEMINI_MODEL_QUALITY,
          volumeModel: env.GEMINI_MODEL_VOLUME,
          maxRetries: env.LLM_MAX_RETRIES,
          requestTimeoutMs: env.LLM_TIMEOUT_MS,
        }, logger)
      : undefined;

  if (llm) {
    // Fail at boot, not three stages into the first job.
    prompts.verifyAll([
      '01-script-generation', '02-scene-diagram', '03-scene-judge',
      '04-quiz-generation', '05-image-reading', '08-visual-plan', '09-story-plan-judge',
    ] satisfies PromptName[]);
  }

  const scriptGenerator = llm
    ? new PromptedScriptGenerator(llm, prompts, imageRegistry.registered, logger)
    : new StubScriptGenerator();
  const storyboardGenerator = llm
    ? new PromptedStoryboardGenerator(llm, prompts, images, logger)
    : new StubStoryboardGenerator();
  const judge = llm
    ? new PromptedQualityJudge(llm, prompts, logger)
    : new StubQualityJudge();
  const planJudge = llm
    ? new PromptedStoryPlanJudge(llm, prompts, logger)
    : new StubStoryPlanJudge();
  const vision = llm
    ? new PromptedVisionReader(llm, prompts)
    : new StubVisionReader();
  const quiz = llm
    ? new PromptedQuizGenerator(llm, prompts)
    : new StubQuizGenerator();
  const visualPlanner = llm
    ? new PromptedVisualPlanner(llm, prompts)
    : new StubVisualPlanner(resolved.defaultTheme);

  const speech =
    env.TTS_DRIVER === 'elevenlabs'
      ? new ElevenLabsSpeechSynthesizer({
          apiKey: requireEnv(env.ELEVENLABS_API_KEY, 'ELEVENLABS_API_KEY'),
          modelId: env.ELEVENLABS_MODEL_ID,
          outputFormat: env.ELEVENLABS_OUTPUT_FORMAT,
          requestTimeoutMs: env.TTS_TIMEOUT_MS,
        }, resolved.voices, logger)
      : env.TTS_DRIVER === 'openai'
        ? new OpenAiSpeechSynthesizer({
            apiKey: requireEnv(env.OPENAI_API_KEY, 'OPENAI_API_KEY'),
            model: env.OPENAI_TTS_MODEL,
            alignModel: env.OPENAI_TTS_ALIGN_MODEL,
            requestTimeoutMs: env.TTS_TIMEOUT_MS,
          }, ffmpeg, logger)
        : env.TTS_DRIVER === 'gemini'
          ? new GeminiSpeechSynthesizer({
              apiKey: requireEnv(env.GEMINI_API_KEY, 'GEMINI_API_KEY'),
              model: env.GEMINI_TTS_MODEL,
              requestTimeoutMs: env.TTS_TIMEOUT_MS,
            }, ffmpeg, logger, aligner)
          : new StubSpeechSynthesizer(ffmpeg, resolved.voices);

  /**
   * Local Whisper is the only transcriber: student audio never leaves the
   * machine, which is both the cleanest GDPR position and free. `stub` reports
   * nothing rather than inventing a transcript.
   */
  const transcriber = env.STT_DRIVER === 'whisper'
    ? new WhisperCliTranscriber({
        binaryPath: env.WHISPER_BINARY,
        modelPath: env.WHISPER_MODEL_PATH,
        threads: env.WHISPER_THREADS,
        timeoutMs: env.STT_TIMEOUT_MS,
      }, ffmpeg, logger)
    : new StubTranscriber(ffmpeg);
  const embedder = new StubEmbedder();
  const browsers = new BrowserPool({
    ...(env.CHROMIUM_PATH ? { executablePath: env.CHROMIUM_PATH } : {}),
    width: resolved.defaultPreset.width,
    height: resolved.defaultPreset.height,
  }, logger);

  const renderer = new PlaywrightSceneRenderer(resolved.defaultTheme, browsers, logger, ffmpeg);

  const previewer = new PlaywrightScenePreviewer(
    resolved.defaultTheme, browsers, logger,
    resolved.defaultPreset.width, resolved.defaultPreset.height,
  );

  const extractors = new ExtractorRegistry()
    .register(new PdfExtractor(resolved.input.maxPdfPages, detector))
    .register(new PlainTextExtractor(detector))
    .register(new DocxExtractor(detector))
    .register(new PptxExtractor(new ArchiveGuard(resolved.input.archive), detector))
    .register(new ImageExtractor(vision, detector))
    .register(new AudioFileExtractor(ffmpeg, resolved.input.maxMediaDurationSeconds))
    .register(new YouTubeExtractor(http, resolved.input.maxMediaDurationSeconds))
    // Registered last: it matches on origin only, so it must not shadow the
    // type-specific extractors above.
    .register(new WebPageExtractor(http, detector));

  // Shared by the two stages that can produce a script: a revision faces the
  // same source-scoping and citation checks the original did.
  const assembler = new ScriptAssembler(new NarrationTextNormalizer());

  const stages: AnyStage[] = [
    new ValidateInputsStage(new MagicByteSniffer()),
    /**
     * Between validation and ingestion, because it produces *sources* and
     * everything downstream is indifferent to where a source came from. With no
     * search driver there is nothing to research with, so the stage is left out
     * entirely rather than being present and inert.
     */
    ...(webSearch && llm ? [new ResearchTopicStage(webSearch, llm)] : []),
    new IngestSourcesStage(extractors),
    new TranscribeAudioStage(transcriber),
    new ConsolidateContentStage(embedder),
    new GenerateScriptStage(scriptGenerator, assembler, visualPlanner),
    // Between the script and the boards, deliberately: this is the last stage at
    // which the *shape* of the video can still change, and the cheapest one that
    // can send work backwards.
    new ReviewStoryPlanStage(planJudge, scriptGenerator, assembler),
    new BuildStoryboardStage(storyboardGenerator),
    new JudgeStoryboardStage(new DeterministicSceneChecks(), judge, storyboardGenerator, previewer),
    new SynthesizeSpeechStage(speech, encoder),
    new GenerateSubtitlesStage(encoder),
    new GenerateQuizStage(quiz),
    new RenderFramesStage(renderer),
    new AssembleVideoStage(encoder),
    new PublishArtifactsStage(storage),
  ];

  logger.info({
    storage: 'local',
    llm: env.LLM_DRIVER,
    ...(llm ? { models: { quality: llm.modelFor('quality'), volume: llm.modelFor('volume') } } : {}),
    tts: env.TTS_DRIVER,
    ...(env.TTS_DRIVER === 'openai' ? { ttsModel: env.OPENAI_TTS_MODEL } : {}),
    ...(env.TTS_DRIVER === 'gemini'
      // The aligner is logged because "no timings" is otherwise only visible as
      // a per-scene warning, and it changes what the video does.
      ? { ttsModel: env.GEMINI_TTS_MODEL, aligner: aligner?.name ?? 'none' }
      : {}),
    stt: env.STT_DRIVER,
    ...(env.STT_DRIVER === 'whisper' ? { whisperModel: env.WHISPER_MODEL_PATH } : {}),
    renderer: 'playwright',
    // Named rather than a boolean: "images: none" is the answer to "why is
    // every board a drawing", and it is otherwise invisible.
    images: images ? images.available.join('+') : 'none',
    search: env.WEB_SEARCH_DRIVER,
    prompts: env.PROMPT_DIR,
    extractors: extractors.registered,
  }, 'adapters bound');

  return {
    redis,
    queue,
    repository,
    workspace,
    storage,
    stages,
    submitJob: new SubmitGenerationJob(repository, queue, workspace, clock, resolved),
    getStatus: new GetJobStatus(repository),
    cancelJob: new CancelJob(repository, queue, clock),
    buildConsumer: () => new BullMqJobConsumer(queueConnection, {
      concurrency: config.queue.workerConcurrency,
      stalledIntervalMs: config.queue.stalledIntervalMs,
      maxStalledCount: resolved.jobMaxAttempts,
      cancellationPollMs: 2000,
      isCancelled: async (jobId) => {
        const job = await repository.find(JobId.of(jobId)).catch(() => undefined);
        return job?.status === 'cancelled';
      },
    }),
    buildProcessor: (onStageComplete) => new ProcessGenerationJob(
      new GenerationPipeline(stages, onStageComplete),
      repository, workspace, clock, resolved, logger,
      () => new CostMeter(pricing, providerNames),
    ),
    sweepOrphans: () => sharedVolume.sweepOrphans(config.raw.workspace.orphanSweepAfterSeconds),
    close: async () => {
      await browsers.close();
      await queue.close();
      redis.disconnect();
      queueConnection.disconnect();
    },
  };
}


/**
 * The theme, in the words an image model understands.
 *
 * Derived rather than configured: the palette a generated picture is drawn in
 * *is* the theme's palette, and a second copy of it in .env would be one more
 * thing to keep in sync with `config/theme.yaml`.
 */
function styleBriefFor(theme: Theme): string {
  const { ink, board, stroke } = theme.tokens;
  return [
    'Style: a marker drawing on a whiteboard. Confident hand-drawn strokes,',
    `roughly ${Math.round(stroke.widthPx)}px wide, with visible line texture and no shading.`,
    `Draw in ${ink.primary} on a flat ${board.background} background,`,
    `using ${[ink.accent, ...ink.accents].slice(0, 3).join(' and ')} sparingly for emphasis.`,
    'No photographic detail, no gradients, no drop shadows, no frame or border.',
  ].join(' ');
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} must be set for the selected driver. See .env.example.`);
  }
  return value;
}
