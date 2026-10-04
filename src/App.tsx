import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CircleHelp,
  Download,
  Film,
  FolderOpen,
  Gauge,
  Layers3,
  LoaderCircle,
  Music2,
  Play,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'

type Model = {
  name: string
  maker: string
  tag: string
  memory: string
  detail: string
  color: string
  installed: boolean
}

type SequenceMedia = { id: string; file: File; url: string; kind: 'image' | 'video'; duration?: number; animate?: boolean }

const models: Model[] = [
  { name: 'Wan 2.1 · 1.3B', maker: 'Alibaba · installed', tag: 'LOCAL READY', memory: '16 GB+', detail: 'Text-to-video, tuned for this GPU', color: 'amber', installed: true },
  { name: 'LTX Video', maker: 'Lightricks · LTX Desktop detected', tag: 'LOCAL READY', memory: '16 GB+', detail: 'Image-to-video via local LTX Desktop', color: 'blue', installed: true },
]



const exportPresets: Record<string, { label: string; aspect: string; width: number; height: number }> = {
  'facebook-feed': { label: 'Facebook Feed · 1080 × 1350', aspect: '9:16', width: 1080, height: 1350 },
  'facebook-reel': { label: 'Facebook Reel / Story · 1080 × 1920', aspect: '9:16', width: 1080, height: 1920 },
  'facebook-landscape': { label: 'Facebook Landscape · 1920 × 1080', aspect: '16:9', width: 1920, height: 1080 },
  original: { label: 'Original format', aspect: '16:9', width: 0, height: 0 },
}

const readSavedChoice = <T extends string>(key: string, fallback: T, choices: readonly T[]): T => {
  try {
    const saved = window.localStorage.getItem(key)
    return saved && choices.includes(saved as T) ? saved as T : fallback
  } catch {
    return fallback
  }
}

function App() {
  const [selectedModel, setSelectedModel] = useState(models[1])
  const [prompt, setPrompt] = useState('')
  const [translationStatus, setTranslationStatus] = useState<'idle' | 'translating' | 'ready' | 'error'>('idle')
  const [translationError, setTranslationError] = useState('')
  const [duration, setDuration] = useState('5 sec')
  const [aspect, setAspect] = useState<string>(() => readSavedChoice('motion.aspect', '9:16', ['16:9', '9:16'] as const))
  const [exportPreset, setExportPreset] = useState<string>(() => readSavedChoice('motion.exportPreset', 'facebook-reel', Object.keys(exportPresets)))
  const [status, setStatus] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [generationMessage, setGenerationMessage] = useState('')
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null)
  const [generationElapsedSeconds, setGenerationElapsedSeconds] = useState(0)
  const [generatedMedia, setGeneratedMedia] = useState<string | null>(null)
  const [generatedMediaIsVideo, setGeneratedMediaIsVideo] = useState(false)
  const [extensionDuration, setExtensionDuration] = useState('5')
  const [referenceImage, setReferenceImage] = useState<string | null>(null)
  const [referenceFile, setReferenceFile] = useState<File | null>(null)
  const [sequenceItems, setSequenceItems] = useState<SequenceMedia[]>([])
  const [muteOriginalAudio, setMuteOriginalAudio] = useState(false)
  const [musicTrack, setMusicTrack] = useState<{ name: string; url: string; file: File } | null>(null)
  const [musicDurationSeconds, setMusicDurationSeconds] = useState(0)
  const [musicTrimStartSeconds, setMusicTrimStartSeconds] = useState(0)
  const [activeView, setActiveView] = useState<'studio' | 'settings'>('studio')
  const [gpuName, setGpuName] = useState('GPU detected locally')
  const [vramTotalMb, setVramTotalMb] = useState(0)
  const [vramUsedMb, setVramUsedMb] = useState<number | null>(null)
  const [fanSpeedPercent, setFanSpeedPercent] = useState<number | null>(null)
  const [gpuTemperatureC, setGpuTemperatureC] = useState<number | null>(null)
  const [topMenu, setTopMenu] = useState<'help' | 'account' | null>(null)
  const [outputDirectory, setOutputDirectory] = useState('D:\\Videos\\videocreation\\outputs')
  const [settingsMessage, setSettingsMessage] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const musicInputRef = useRef<HTMLInputElement>(null)
  const musicPreviewRef = useRef<HTMLAudioElement>(null)
  const cancelRequestedRef = useRef(false)
  const generationControllerRef = useRef<AbortController | null>(null)
  const translationRequestRef = useRef<{ source: string; promise: Promise<string> } | null>(null)

  useEffect(() => {
    try {
      window.localStorage.setItem('motion.aspect', aspect)
      window.localStorage.setItem('motion.exportPreset', exportPreset)
    } catch {
      // Keep the current selections for this session if storage is unavailable.
    }
  }, [aspect, exportPreset])

  useEffect(() => {
    if (status !== 'connecting' || generationStartedAt === null) return
    const updateElapsed = () => setGenerationElapsedSeconds(Math.floor((Date.now() - generationStartedAt) / 1000))
    updateElapsed()
    const interval = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(interval)
  }, [status, generationStartedAt])

  const estimatedRenderSeconds = selectedModel.name === 'LTX Video'
    ? 75 + Number.parseInt(duration, 10) * 12
    : 120 + Number.parseInt(duration, 10) * 20
  const renderProgress = status === 'connecting' ? Math.min(95, Math.max(3, Math.round((generationElapsedSeconds / estimatedRenderSeconds) * 100))) : generatedMedia ? 100 : 0
  const remainingSeconds = Math.max(0, estimatedRenderSeconds - generationElapsedSeconds)
  const canStopGeneration = status === 'connecting' || (status === 'error' && /generation already in progress/i.test(generationMessage))
  const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  useEffect(() => {
    const canvas = document.createElement('canvas')
    const context = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!context) return
    const debugInfo = context.getExtension('WEBGL_debug_renderer_info')
    const renderer = debugInfo
      ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string
      : context.getParameter(context.RENDERER) as string
    if (renderer && renderer !== 'WebKit WebGL') setGpuName(renderer.replace(/^ANGLE \(/, '').replace(/\)$/, ''))
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadSystemInfo = async () => {
      try {
        const system = await fetch('http://127.0.0.1:41955/system').then((response) => response.json() as Promise<{ gpuName?: string; vramTotalMb?: number; vramUsedMb?: number | null; fanSpeedPercent?: number | null; gpuTemperatureC?: number | null }> )
        if (cancelled) return
        if (system.gpuName) setGpuName(system.gpuName)
        if (system.vramTotalMb) setVramTotalMb(system.vramTotalMb)
        setVramUsedMb(system.vramUsedMb ?? null)
        setFanSpeedPercent(Number.isFinite(system.fanSpeedPercent) ? system.fanSpeedPercent ?? null : null)
        setGpuTemperatureC(Number.isFinite(system.gpuTemperatureC) ? system.gpuTemperatureC ?? null : null)
      } catch {
        // The bridge may still be starting; WebGL remains the visible fallback.
      }
    }
    void loadSystemInfo()
    const interval = window.setInterval(() => void loadSystemInfo(), 2000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadLocalState = async (attempt = 0): Promise<void> => {
      try {
        const config = await fetch('http://127.0.0.1:41955/config').then((response) => response.json() as Promise<{ outputDirectory?: string }>)
        if (cancelled) return
        if (config.outputDirectory) setOutputDirectory(config.outputDirectory)
      } catch {
        if (attempt < 12 && !cancelled) window.setTimeout(() => void loadLocalState(attempt + 1), 500)
      }
    }
    void loadLocalState()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    fetch('http://127.0.0.1:41955/latest')
      .then((response) => response.ok ? response.json() as Promise<{ data?: string; mimeType?: string }> : null)
      .then((result) => {
        if (!result?.data || !result.mimeType) return
        setGeneratedMedia(`data:${result.mimeType};base64,${result.data}`)
        setGeneratedMediaIsVideo(true)
        setGenerationMessage('Latest local video restored.')
      })
      .catch(() => undefined)
  }, [])

  const prepareReferenceImage = async (file: File, targetAspect: string, preserveComposition = false) => {
    const image = new Image()
    image.src = URL.createObjectURL(file)
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Unable to read the reference image.'))
    })
    const [targetWidth, targetHeight] = targetAspect === '9:16' ? [720, 1280] : [1280, 720]
    const scaleX = targetWidth / image.naturalWidth
    const scaleY = targetHeight / image.naturalHeight
    const scale = preserveComposition ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY)
    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Unable to prepare the reference image.')
    context.fillStyle = '#101216'
    context.fillRect(0, 0, targetWidth, targetHeight)
    const width = image.naturalWidth * scale
    const height = image.naturalHeight * scale
    context.drawImage(image, (targetWidth - width) / 2, (targetHeight - height) / 2, width, height)
    URL.revokeObjectURL(image.src)
    return canvas.toDataURL('image/png')
  }

  const translatePromptLocally = async (sourcePrompt: string) => {
    const source = sourcePrompt.trim()
    if (!source) return ''
    if (translationRequestRef.current?.source === source) return translationRequestRef.current.promise
    setTranslationStatus('translating')
    setTranslationError('')
    const translation = (async () => {
      try {
        const response = await fetch('http://127.0.0.1:41955/translate-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: source }),
        })
        const result = await response.json() as { translatedPrompt?: string; message?: string }
        if (!response.ok || !result.translatedPrompt?.trim()) {
          throw new Error(result.message ?? 'Unable to translate the prompt locally.')
        }
        const translated = result.translatedPrompt.trim()
        setPrompt((currentPrompt) => currentPrompt.trim() === source ? translated : currentPrompt)
        setTranslationStatus('ready')
        return translated
      } catch (error) {
        setTranslationStatus('error')
        setTranslationError(error instanceof Error ? error.message : 'Unable to translate the prompt locally.')
        throw error
      }
    })()
    translationRequestRef.current = { source, promise: translation }
    try {
      return await translation
    } finally {
      if (translationRequestRef.current?.promise === translation) translationRequestRef.current = null
    }
  }

  const generateWithLtx = async (hasMusic = false) => {
    if (!referenceFile && sequenceItems.length === 0) throw new Error('Add at least one image or video before generating.')
    const generationAspect = exportPreset === 'facebook-feed' || aspect === '4:5' ? '9:16' : aspect
    if (!['16:9', '9:16'].includes(generationAspect)) throw new Error('LTX local I2V supports 16:9 and 9:16 only.')
    const preserveComposition = true
    const mediaItems = sequenceItems.length > 0 ? sequenceItems : referenceFile ? [{ id: 'reference', file: referenceFile, url: referenceImage ?? '', kind: 'image' as const }] : []
    const preparedItems = await Promise.all(mediaItems.map(async (item) => item.kind === 'video'
      ? { kind: item.kind, data: await fileToDataUrl(item.file) }
      : { kind: item.kind, animate: item.animate !== false, data: await prepareReferenceImage(item.file, generationAspect, preserveComposition) }))
    const motionPrompt = prompt.trim()
    const needsImageAnimation = preparedItems.some((item) => item.kind === 'image' && item.animate !== false)
    const controller = new AbortController()
    generationControllerRef.current = controller
    const isSequence = preparedItems.length > 1 || preparedItems.some((item) => item.kind === 'video' || (item.kind === 'image' && item.animate === false))
    if (isSequence) setGenerationMessage(`Assembling ${preparedItems.length} media clips...`)
    const response = await fetch(isSequence ? 'http://127.0.0.1:41955/sequence' : 'http://127.0.0.1:41955/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(isSequence ? { items: preparedItems } : { imageData: preparedItems[0]?.data }), muteOriginalAudio, hasMusic, exportPreset, prompt: motionPrompt, duration: Number.parseInt(duration, 10), aspectRatio: generationAspect }),
      signal: controller.signal,
    })
    const result = await response.json() as { data?: string; mimeType?: string; message?: string }
    if (!response.ok || !result.data || !result.mimeType) throw new Error(result.message ?? `LTX request failed (${response.status}).`)
    const media = result
    return `data:${media.mimeType};base64,${media.data}`
  }

  const generate = async () => {
    const selectedMusic = musicTrack
    if (exportPreset.startsWith('facebook-') && selectedModel.name !== 'LTX Video') {
      setStatus('error')
      setGeneratedMedia(null)
      setGeneratedMediaIsVideo(false)
      setGenerationMessage('Facebook export uses LTX Video to create the selected format. Select LTX Video first.')
      return
    }
    if (selectedModel.name === 'LTX Video' && !referenceImage && sequenceItems.length === 0) {
      setStatus('error')
      setGeneratedMedia(null)
      setGeneratedMediaIsVideo(false)
      setGenerationMessage('Import an image first. LTX Video uses the selected image to create the animation.')
      return
    }
    if ((referenceImage || sequenceItems.length > 0) && selectedModel.name === 'Wan 2.1 · 1.3B') {
      setStatus('error')
      setGeneratedMedia(null)
      setGeneratedMediaIsVideo(false)
      setGenerationMessage('Reference images require the LTX Desktop I2V engine. Wan 2.1 · 1.3B is text-to-video only, so no unrelated video was created.')
      return
    }
    if ((referenceImage || sequenceItems.length > 0) && selectedModel.name === 'LTX Video') {
      cancelRequestedRef.current = false
      setStatus('connecting')
      setGenerationStartedAt(Date.now())
      setGenerationElapsedSeconds(0)
      setGeneratedMedia(null)
      setGeneratedMediaIsVideo(false)
      setGenerationMessage('Generating with LTX Desktop I2V...')
      try {
        const media = await generateWithLtx(Boolean(selectedMusic))
        setGenerationMessage(selectedMusic ? 'Adding music to the video...' : 'Video ready.')
        const mixedMedia = await mixVideoWithMusic(media, selectedMusic)
        setGeneratedMedia(mixedMedia)
        setGeneratedMediaIsVideo(true)
        setStatus('idle')
        setGenerationMessage('Video ready.')
      } catch (error) {
        if (cancelRequestedRef.current) {
          cancelRequestedRef.current = false
          setStatus('idle')
          setGenerationMessage('Video generation cancelled.')
          return
        }
        setStatus('error')
        setGenerationMessage(error instanceof Error ? error.message : 'Unable to reach LTX Desktop.')
      }
      return
    }
    if (selectedModel.name !== 'Wan 2.1 · 1.3B') {
      setStatus('error')
      setGenerationMessage('This model is not installed on this machine.')
      return
    }
    setStatus('connecting')
    setGenerationStartedAt(Date.now())
    setGenerationElapsedSeconds(0)
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
    setGenerationMessage('Connecting to ComfyUI...')
    try {
      const workflow = await fetch('/wan_text_to_video_api.json').then((response) => response.json())
      const videoPrompt = prompt.trim()
      workflow['6'].inputs.text = videoPrompt
      const dimensions: Record<string, [number, number]> = {
        '16:9': [512, 288],
        '9:16': [288, 512],
        '3:4': [384, 512],
        '1:1': [384, 384],
      }
      const [width, height] = dimensions[aspect] ?? dimensions['16:9']
      workflow['40'].inputs.width = width
      workflow['40'].inputs.height = height
      workflow['40'].inputs.length = Number.parseInt(duration, 10) * 16 + 1
      workflow['3'].inputs.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
      const response = await fetch('http://127.0.0.1:8188/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: 'motion-local' }) })
      const result = await response.json()
      if (!response.ok || !result.prompt_id) throw new Error(result.error?.message ?? 'ComfyUI rejected the workflow')
      setGenerationMessage('Rendering locally. This can take a few minutes...')
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000))
        if (cancelRequestedRef.current) throw new Error('Generation cancelled by user.')
        const history = await fetch(`http://127.0.0.1:8188/history/${result.prompt_id}`).then((item) => item.json())
        const outputs = history[result.prompt_id]?.outputs ?? {}
        const outputNodes = [outputs['47'], outputs['28']].filter(Boolean)
        const output = outputNodes.flatMap((item) => (item as { gifs?: Array<{ filename: string; subfolder: string; type: string }>; images?: Array<{ filename: string; subfolder: string; type: string }> }).gifs ?? (item as { images?: Array<{ filename: string; subfolder: string; type: string }> }).images ?? [])[0]
        if (output) {
          const media = output as { filename: string; subfolder: string; type: string }
          const mediaUrl = `http://127.0.0.1:8188/view?filename=${encodeURIComponent(media.filename)}&subfolder=${encodeURIComponent(media.subfolder)}&type=${encodeURIComponent(media.type)}`
          setGenerationMessage(selectedMusic ? 'Adding music to the video...' : 'Video ready.')
          const mixedMedia = await mixVideoWithMusic(mediaUrl, selectedMusic)
          setGeneratedMedia(mixedMedia)
          setGeneratedMediaIsVideo(true)
          setStatus('idle')
          setGenerationMessage('Video ready.')
          return
        }
      }
      throw new Error('Rendering timed out')
    } catch (error) {
      setStatus('error')
      setGenerationMessage(error instanceof Error ? error.message : 'Unable to render Wan video. Check that ComfyUI is running and the Wan workflow is loaded.')
    }
  }

  const importMedia = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) return
    const additions = files.filter((file) => file.type.startsWith('image/') || file.type.startsWith('video/')).map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file), kind: file.type.startsWith('video/') ? 'video' as const : 'image' as const, animate: true }))
    if (additions.length === 0) {
      setGenerationMessage('Choose image or video files to add to the sequence.')
      event.target.value = ''
      return
    }
    const nextItems = [...sequenceItems, ...additions].slice(0, 20)
    additions.slice(Math.max(0, 20 - sequenceItems.length)).forEach((item) => URL.revokeObjectURL(item.url))
    const firstItem = sequenceItems[0] ?? nextItems[0]
    setSequenceItems(nextItems)
    setReferenceImage(firstItem?.url ?? null)
    setReferenceFile(firstItem?.kind === 'image' ? firstItem.file : null)
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
    setGenerationMessage(`${Math.min(additions.length, Math.max(0, 20 - sequenceItems.length))} media item${additions.length === 1 ? '' : 's'} added. Images will be animated; video clips will keep their original motion.`)
    setStatus('idle')
    event.target.value = ''
  }

  const updateVideoDuration = (id: string, durationSeconds: number) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return
    setSequenceItems((items) => items.map((item) => item.id === id ? { ...item, duration: durationSeconds } : item))
  }

  const toggleSequenceAnimation = (id: string) => {
    setSequenceItems((items) => items.map((item) => item.id === id && item.kind === 'image' ? { ...item, animate: item.animate === false } : item))
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
  }

  const removeSequenceItem = (id: string) => {
    const removed = sequenceItems.find((item) => item.id === id)
    if (removed) URL.revokeObjectURL(removed.url)
    const nextItems = sequenceItems.filter((item) => item.id !== id)
    setSequenceItems(nextItems)
    setReferenceImage(nextItems[0]?.url ?? null)
    setReferenceFile(nextItems[0]?.kind === 'image' ? nextItems[0].file : null)
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
  }

  const moveSequenceItem = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= sequenceItems.length) return
    const nextItems = [...sequenceItems]
    ;[nextItems[index], nextItems[targetIndex]] = [nextItems[targetIndex], nextItems[index]]
    setSequenceItems(nextItems)
    setReferenceImage(nextItems[0].url)
    setReferenceFile(nextItems[0].kind === 'image' ? nextItems[0].file : null)
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
  }

  const removeImage = () => {
    sequenceItems.forEach((item) => URL.revokeObjectURL(item.url))
    setSequenceItems([])
    setMuteOriginalAudio(false)
    setReferenceImage(null)
    setReferenceFile(null)
  }

  const removeVideo = () => {
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
    setGenerationMessage('Video removed from the preview.')
    setStatus('idle')
  }

  const removeMusic = () => {
    setMusicTrack((currentTrack) => {
      if (currentTrack) URL.revokeObjectURL(currentTrack.url)
      return null
    })
    setMusicDurationSeconds(0)
    setMusicTrimStartSeconds(0)
    setGenerationMessage('Audio removed. The next video will use speech only.')
  }

  const startNewVideo = () => {
    setPrompt('')
    setTranslationStatus('idle')
    setTranslationError('')
    setSelectedModel(models[1])
    setDuration('5 sec')
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
    setReferenceImage((currentImage) => {
      if (currentImage) URL.revokeObjectURL(currentImage)
      return null
    })
    sequenceItems.forEach((item) => URL.revokeObjectURL(item.url))
    setSequenceItems([])
    setReferenceFile(null)
    setMusicTrack((currentTrack) => {
      if (currentTrack) URL.revokeObjectURL(currentTrack.url)
      return null
    })
    setMusicDurationSeconds(0)
    setMusicTrimStartSeconds(0)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (musicInputRef.current) musicInputRef.current.value = ''
    setGenerationMessage('New video ready.')
    setStatus('idle')
    setActiveView('studio')
  }

  const saveSettings = async () => {
    setSettingsMessage('Saving...')
    try {
      const response = await fetch('http://127.0.0.1:41955/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outputDirectory }) })
      const result = await response.json() as { outputDirectory?: string; message?: string }
      if (!response.ok || !result.outputDirectory) throw new Error(result.message ?? 'Unable to save output path.')
      setOutputDirectory(result.outputDirectory)
      setSettingsMessage('Saved for future renders.')
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : 'Unable to save output path.')
    }
  }

  const pickOutputDirectory = async () => {
    setSettingsMessage('Opening folder picker...')
    try {
      const response = await fetch('http://127.0.0.1:41955/pick-directory', { method: 'POST' })
      const result = await response.json() as { outputDirectory?: string; message?: string; cancelled?: boolean }
      if (!response.ok) throw new Error(result.message ?? 'Unable to open the folder picker.')
      if (result.outputDirectory) {
        setOutputDirectory(result.outputDirectory)
        setSettingsMessage('Folder selected. Save to apply it.')
      } else if (result.cancelled) {
        setSettingsMessage('Folder selection cancelled.')
      }
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : 'Unable to open the folder picker.')
    }
  }

  const importMusic = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setMusicTrack((currentTrack) => {
      if (currentTrack) URL.revokeObjectURL(currentTrack.url)
      return { name: file.name, url: URL.createObjectURL(file), file }
    })
    setMusicDurationSeconds(0)
    setMusicTrimStartSeconds(0)
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
    setGenerationMessage('Audio selected. Generate the video to embed it.')
    event.target.value = ''
  }

  const formatMusicTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

  const fileToDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Unable to read the music file.'))
    reader.readAsDataURL(file)
  })

  const mixVideoWithMusic = async (videoUrl: string, track: { name: string; url: string; file: File } | null = musicTrack, preserveOriginalAudio = sequenceItems.some((item) => item.kind === 'video') && !muteOriginalAudio) => {
    if (!track) return videoUrl
    const response = await fetch('http://127.0.0.1:41955/mix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioData: await fileToDataUrl(track.file), trimStart: musicTrimStartSeconds, preserveOriginalAudio, ...(videoUrl.startsWith('data:') ? { videoData: videoUrl } : { videoUrl }) }),
    })
    const result = await response.json() as { data?: string; mimeType?: string; message?: string }
    if (!response.ok || !result.data || !result.mimeType) throw new Error(result.message ?? 'Unable to add music to the video.')
    return `data:${result.mimeType};base64,${result.data}`
  }

  const extendGeneratedVideo = async () => {
    if (!generatedMedia || !generatedMediaIsVideo) return
    const preserveComposition = exportPreset === 'facebook-feed' || aspect === '4:5'
    cancelRequestedRef.current = false
    setStatus('connecting')
    setGenerationStartedAt(Date.now())
    setGenerationElapsedSeconds(0)
    setGenerationMessage('Extending the video locally...')
    try {
      const currentPrompt = prompt.trim()
      const extensionPrompt = [
        currentPrompt,
        preserveComposition ? 'Continue with the same wide group framing as the existing video. Keep every person visible at both edges of the frame. Locked static camera, no zoom, crop, or reframing.' : '',
      ].filter(Boolean).join(' ')
      const response = await fetch('http://127.0.0.1:41955/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoData: generatedMedia, duration: Number(extensionDuration), prompt: extensionPrompt, aspectRatio: aspect, exportPreset }),
      })
      const result = await response.json() as { data?: string; mimeType?: string; message?: string }
      if (!response.ok || !result.data || !result.mimeType) throw new Error(result.message ?? 'Unable to extend the video.')
      const extendedMedia = `data:${result.mimeType};base64,${result.data}`
      setGenerationMessage(musicTrack ? 'Adding music to the extended video...' : 'Video extended.')
    setGeneratedMedia(await mixVideoWithMusic(extendedMedia, musicTrack))
      setStatus('idle')
      setGenerationMessage('Video extended.')
    } catch (error) {
      if (cancelRequestedRef.current) {
        cancelRequestedRef.current = false
        setStatus('idle')
        setGenerationMessage('Video extension cancelled.')
        return
      }
      setStatus('error')
      setGenerationMessage(error instanceof Error ? error.message : 'Unable to extend the video.')
    }
  }

  const cancelGeneration = async () => {
    if (!canStopGeneration) return
    const clearingBusyState = status === 'error'
    cancelRequestedRef.current = true
    setGenerationMessage('Stopping generation...')
    generationControllerRef.current?.abort()
    try {
      const response = await fetch('http://127.0.0.1:41955/cancel', { method: 'POST' })
      if (!response.ok) throw new Error('The local video service did not accept the stop request.')
      if (clearingBusyState) {
        setStatus('idle')
        setGenerationStartedAt(null)
        setGenerationMessage('Stop request sent to the active render.')
      }
    } catch (error) {
      if (clearingBusyState) {
        setStatus('idle')
        setGenerationStartedAt(null)
        setGenerationMessage(error instanceof Error ? error.message : 'Unable to stop the active render.')
      }
    }
    try { await fetch('http://127.0.0.1:8188/interrupt', { method: 'POST' }) } catch { /* ComfyUI may not be running. */ }
  }

  const updateMusicTrimStart = (start: number) => {
    setMusicTrimStartSeconds(start)
    const audio = musicPreviewRef.current
    if (audio) audio.currentTime = start
  }

  const canvasActions = <div className="canvas-actions"><button className="new-video-button" onClick={startNewVideo}><Plus size={15} /> New video</button><div className="import-control"><input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,video/x-matroska" multiple onChange={importMedia} /><button className="text-button" onClick={() => fileInputRef.current?.click()}><Film size={16} /> {sequenceItems.length ? 'Add media' : 'Import media'}</button>{sequenceItems.length > 0 && <button className="remove-image" onClick={removeImage} aria-label="Remove all sequence media" title="Remove all media"><X size={14} /></button>}</div></div>

  return (
    <main className="app-shell">
      <nav className="topbar">
        <div className="brand" aria-label="motion"><span>mo</span>tion<span className="brand-dot">.</span></div>
        <div className="nav-links"><button className="active" onClick={() => setActiveView('studio')}>Studio</button></div>
        <div className="nav-project-actions">{canvasActions}</div>
        <div className="top-actions"><div className="top-gpu-status" title={gpuName}><span className="green-dot" /> <strong>GPU ready</strong><span>·</span><span className="top-gpu-name">{gpuName}</span><span>·</span><span>{vramUsedMb !== null && vramTotalMb > 0 ? `${(vramUsedMb / 1024).toFixed(1)} / ${(vramTotalMb / 1024).toFixed(1)} GB VRAM` : '-- / -- GB VRAM'}</span><span>·</span><span>{fanSpeedPercent !== null ? `fan ${fanSpeedPercent}%` : 'fan --'}</span><span>·</span><span>{gpuTemperatureC !== null ? `${gpuTemperatureC} °C` : '-- °C'}</span></div><span className="local-pill" title="All generation stays on this computer"><i /> Local mode</span><button className="settings-top-button" onClick={() => setActiveView('settings')}><Settings2 size={15} /> Settings</button><div className="top-menu-wrap"><button className="icon-button" aria-label="Help" aria-expanded={topMenu === 'help'} onClick={() => setTopMenu((current) => current === 'help' ? null : 'help')}><CircleHelp size={18} /></button>{topMenu === 'help' && <div className="top-menu"><strong>Local studio</strong><span>Generation, media and audio stay on this computer.</span></div>}</div><div className="top-menu-wrap"><button className="avatar" aria-label="Account" aria-expanded={topMenu === 'account'} onClick={() => setTopMenu((current) => current === 'account' ? null : 'account')}>R</button>{topMenu === 'account' && <div className="top-menu account-menu"><strong>Local account</strong><span>R</span></div>}</div></div>
      </nav>

      <section className="workspace">
        <aside className="sidebar">
          {activeView === 'studio' && <div className="studio-controls">
            {sequenceItems.some((item) => item.kind === 'video') && <label className="mute-original-audio"><input type="checkbox" checked={muteOriginalAudio} onChange={(event) => setMuteOriginalAudio(event.target.checked)} /><span>Mute original clip audio</span><small>{musicTrack ? (muteOriginalAudio ? 'Your inserted music replaces the clips’ sound.' : 'Original clip sound is mixed quietly under your music.') : 'Imported clips will be silent; add music if you want a soundtrack.'}</small></label>}
            <div className="controls"><label><span>EXPORT PRESET</span><div className="select-control-wrap"><select className="select-control" value={exportPreset} onChange={(event) => { const nextPreset = event.target.value; setExportPreset(nextPreset); setAspect(exportPresets[nextPreset].aspect); if (nextPreset.startsWith('facebook-')) setDuration('5 sec') }}>{Object.entries(exportPresets).map(([value, preset]) => <option key={value} value={value}>{preset.label}</option>)}</select><span className="select-chevron">⌄</span></div></label><label><span>MODEL</span><div className="select-control-wrap"><span className={`model-mark ${selectedModel.color}`}><Layers3 size={13} /></span><select className="select-control model-select" value={selectedModel.name} onChange={(event) => setSelectedModel(models.find((model) => model.name === event.target.value) ?? models[0])}>{models.map((model) => <option key={model.name} value={model.name} disabled={!model.installed}>{model.name}{model.installed ? '' : ' · not installed'}</option>)}</select><span className="select-chevron">⌄</span></div></label><label><span>DURATION</span><div className="select-control-wrap"><select className="select-control" value={duration} onChange={(event) => setDuration(event.target.value)}><option>3 sec</option><option>5 sec</option><option>8 sec</option><option>10 sec</option></select><span className="select-chevron">⌄</span></div></label><label><span>FORMAT</span><div className="select-control-wrap"><select className="select-control" value={aspect} onChange={(event) => setAspect(event.target.value)}><option>16:9</option><option>9:16</option></select><span className="select-chevron">⌄</span></div></label></div>
            {generationMessage && <p className={`generation-message ${status === 'error' ? 'error' : ''}`}>{generationMessage}</p>}
            {canStopGeneration && <button className="cancel-render-button" onClick={cancelGeneration}><X size={14} /> Stop generation</button>}
            {status === 'connecting' && <div className="render-progress" aria-live="polite"><div className="render-progress-top"><span>RENDERING {renderProgress}%</span><span>ETA ~{formatTime(remainingSeconds)}</span></div><div className="render-progress-track"><span style={{ width: `${renderProgress}%` }} /></div><div className="render-progress-bottom"><span>Elapsed {formatTime(generationElapsedSeconds)}</span><span>Estimate updates live</span></div></div>}
            <div className="music-section">
              <div className="music-control canvas-music-control"><input ref={musicInputRef} type="file" accept="audio/*" onChange={importMusic} /><button className="music-button" onClick={() => musicInputRef.current?.click()}><Music2 size={16} /> {musicTrack ? 'Change music' : 'Insert audio'}</button>{musicTrack && <><span title={musicTrack.name}>{musicTrack.name}</span><button className="remove-music" onClick={removeMusic} aria-label="Remove selected music" title="Remove music"><X size={14} /></button></>}</div>
              {musicTrack && <><div className="music-trim-control"><label><span>START · {formatMusicTime(musicTrimStartSeconds)}</span><input type="range" min="0" max={Math.max(0, musicDurationSeconds - 1)} step="1" value={Math.min(musicTrimStartSeconds, Math.max(0, musicDurationSeconds - 1))} disabled={!musicDurationSeconds} onChange={(event) => updateMusicTrimStart(Number(event.target.value))} /></label></div><small className="music-trim-hint">Choose where the music starts; it plays to the end of the video.</small><audio ref={musicPreviewRef} className="music-player" src={musicTrack.url} controls onLoadedMetadata={(event) => { const trackDuration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0; setMusicDurationSeconds(trackDuration) }} onPlay={(event) => { const audio = event.currentTarget; if (audio.currentTime < musicTrimStartSeconds) audio.currentTime = musicTrimStartSeconds }} /></>}
            </div>
          </div>}
          <div className="side-divider" />
        </aside>

        {activeView === 'settings' && <div className="utility-panel"><div className="utility-head"><div><p className="section-kicker">PREFERENCES</p><h2>Settings</h2></div><button className="text-button" onClick={() => setActiveView('studio')}>Back to Studio</button></div><div className="settings-list"><label><span>ENGINE</span><strong>Local GPU rendering</strong></label><label className="settings-path"><span>VIDEO OUTPUT</span><div><div className="path-controls"><input value={outputDirectory} onChange={(event) => setOutputDirectory(event.target.value)} aria-label="Video output directory" /><button className="pick-directory" onClick={pickOutputDirectory}><FolderOpen size={14} /> Browse</button></div><button className="save-settings" onClick={saveSettings}>Save path</button>{settingsMessage && <small>{settingsMessage}</small>}</div></label><label><span>ACTIVE MODEL</span><strong>{selectedModel.name}</strong></label></div></div>}
        <div className="canvas-area">
          <div className="canvas-head"><div><p className="section-kicker">NEW PROJECT</p><h2>Describe your shot</h2></div></div>
          <div className="media-grid">
            {sequenceItems.length > 0 && <div className="reference-column"><div className="reference-image">{sequenceItems[0].kind === 'video' ? <video src={sequenceItems[0].url} muted playsInline onLoadedMetadata={(event) => updateVideoDuration(sequenceItems[0].id, event.currentTarget.duration)} /> : <img src={sequenceItems[0].url} alt="First image in sequence" />}<span>{sequenceItems.length > 1 ? 'SEQUENCE PREVIEW' : sequenceItems[0].kind === 'video' ? 'VIDEO CLIP' : 'REFERENCE IMAGE'}</span>{sequenceItems.length === 1 && sequenceItems[0].kind === "image" && <button className="single-image-toggle" onClick={() => toggleSequenceAnimation(sequenceItems[0].id)} title={sequenceItems[0].animate === false ? "Animate photo" : "Keep photo still"}><Sparkles size={13} /> {sequenceItems[0].animate === false ? "Animate photo" : "Keep photo still"}</button>}</div>{sequenceItems.length > 1 && <div className="sequence-editor"><div className="sequence-editor-heading"><span>{sequenceItems.length} MEDIA ITEMS</span><small>Use arrows to set playback order</small></div><div className="sequence-thumbnails">{sequenceItems.map((item, index) => <div className="sequence-thumbnail" key={item.id}>{item.kind === 'video' ? <video src={item.url} muted playsInline onLoadedMetadata={(event) => updateVideoDuration(item.id, event.currentTarget.duration)} /> : <img src={item.url} alt={`Sequence image ${index + 1}`} />}<span className="sequence-number">{String(index + 1).padStart(2, '0')} · {item.kind === 'video' ? 'VIDEO' : item.animate === false ? 'STILL' : 'PHOTO'}</span><div className="sequence-thumbnail-actions"><button onClick={() => moveSequenceItem(index, -1)} disabled={index === 0} aria-label={`Move media ${index + 1} earlier`} title="Move earlier"><ArrowUp size={12} /></button><button onClick={() => moveSequenceItem(index, 1)} disabled={index === sequenceItems.length - 1} aria-label={`Move media ${index + 1} later`} title="Move later"><ArrowDown size={12} /></button>{item.kind === 'image' && <button className={item.animate === false ? 'sequence-still-toggle is-still' : 'sequence-still-toggle'} onClick={() => toggleSequenceAnimation(item.id)} aria-label={item.animate === false ? `Animate photo ${index + 1}` : `Keep photo ${index + 1} still`} title={item.animate === false ? 'Animate photo' : 'Keep photo still'}><Sparkles size={12} /></button>}<button onClick={() => removeSequenceItem(item.id)} aria-label={`Remove media ${index + 1}`} title="Remove media"><X size={12} /></button></div></div>)}</div><small className="sequence-duration-note">Photos are animated separately; click the sparkle to keep a photo still. Video clips keep their original motion and duration.</small></div>}<button className="image-generate-button" onClick={generate} disabled={status === 'connecting'}>{status === 'connecting' ? <><LoaderCircle className="spin" size={16} /> Rendering...</> : <><Sparkles size={16} /> {sequenceItems.length > 1 ? 'Generate sequence' : 'Generate video'} <ArrowUpRight size={16} /></>}</button></div>}
            <section className="center-preview"><div className="preview-head"><span>PREVIEW</span><span className="render-status"><i /> {generatedMedia ? 'Complete' : status === 'connecting' ? 'Rendering' : 'Ready'}</span></div><div className="standard-preview"><div className={`preview-frame ${aspect === '9:16' ? 'portrait-preview' : ''}`} style={{ aspectRatio: aspect.replace(':', ' / ') }}>{generatedMedia ? generatedMediaIsVideo ? <video className="generated-video" src={generatedMedia} controls playsInline preload="metadata" /> : <img className="generated-video" src={generatedMedia} alt="Generated video preview" /> : <><div className="preview-placeholder"><div className="play-ring"><Play size={17} fill="currentColor" /></div><span>Your next shot<br /><b>will live here</b></span></div></>}</div></div>{generatedMedia && <div className="preview-actions"><div className="video-file-actions"><a className="download-button" href={generatedMedia} download={`${exportPreset}-${exportPresets[exportPreset].width}x${exportPresets[exportPreset].height}.mp4`} title="Download video"><Download size={15} /> Download video</a><button className="delete-button" onClick={removeVideo} title="Delete video"><Trash2 size={15} /> Delete</button></div><div className="extend-control"><select value={extensionDuration} onChange={(event) => setExtensionDuration(event.target.value)} aria-label="Additional video duration"><option value="5">+5 sec</option><option value="10">+10 sec</option><option value="20">+20 sec</option></select><button className="extend-button" onClick={extendGeneratedVideo} disabled={status === 'connecting'}>Extend</button></div></div>}<div className="preview-note"><Gauge size={15} /><span>{exportPreset.startsWith('facebook-') ? `${exportPresets[exportPreset].label} · MP4` : 'Rendered locally on your GPU'}</span></div></section>
          </div>
          {activeView === 'studio' && <div className="prompt-card canvas-prompt-card">
            <div className="prompt-top"><span className="prompt-label">VIDEO PROMPT</span><span className="prompt-count">{prompt.length} / 1,000</span></div>
            <textarea value={prompt} onChange={(event) => { setPrompt(event.target.value.slice(0, 1000)); setTranslationStatus('idle'); setTranslationError('') }} disabled={translationStatus === 'translating'} maxLength={1000} spellCheck={false} aria-label="Video prompt in Italian or English" />
            <button className="translate-prompt-button" onClick={() => { void translatePromptLocally(prompt).catch(() => undefined) }} disabled={!prompt.trim() || translationStatus === 'translating' || translationStatus === 'ready' || status === 'connecting'}>{translationStatus === 'translating' ? 'Translating locally…' : translationStatus === 'ready' ? 'Translated to English' : 'Translate to English'}</button>
            {translationStatus === 'error' && translationError && <p className="translation-error">{translationError}</p>}
          </div>}
        </div>

      </section>
      <footer><span>motion / v0.1 alpha</span><span>Open weights, open possibilities.</span></footer>
    </main>
  )
}

export default App
