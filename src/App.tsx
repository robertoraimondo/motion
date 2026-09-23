import { useEffect, useRef, useState } from 'react'
import {
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
  WandSparkles,
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

const models: Model[] = [
  { name: 'Wan 2.1 · 1.3B', maker: 'Alibaba · installed', tag: 'LOCAL READY', memory: '16 GB+', detail: 'Text-to-video, tuned for this GPU', color: 'amber', installed: true },
  { name: 'LTX Video', maker: 'Lightricks · LTX Desktop detected', tag: 'LOCAL READY', memory: '16 GB+', detail: 'Image-to-video via local LTX Desktop', color: 'blue', installed: true },
]

const examples = [
  { label: 'Hand wave', prompt: 'The father gently waves with his raised hand to his children. Keep the camera completely still, with natural facial movement and a warm sunset mood.' },
  { label: 'Portrait study', prompt: 'Close-up portrait of an elderly sailor by a window, soft morning light, subtle breathing and eye movement' },
  { label: 'Desert wind', prompt: 'A lone traveler crosses a red desert at golden hour, fabric moving in the wind, wide cinematic shot' },
]

function App() {
  const [selectedModel, setSelectedModel] = useState(models[1])
  const [prompt, setPrompt] = useState(examples[0].prompt)
  const [requestText, setRequestText] = useState('')
  const [duration, setDuration] = useState('5 sec')
  const [aspect, setAspect] = useState('9:16')
  const [exportPreset, setExportPreset] = useState('facebook-reel')
  const [status, setStatus] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [generationMessage, setGenerationMessage] = useState('')
  const [generatedMedia, setGeneratedMedia] = useState<string | null>(null)
  const [generatedMediaIsVideo, setGeneratedMediaIsVideo] = useState(false)
  const [extensionDuration, setExtensionDuration] = useState('5')
  const [referenceImage, setReferenceImage] = useState<string | null>(null)
  const [referenceFile, setReferenceFile] = useState<File | null>(null)
  const [musicTrack, setMusicTrack] = useState<{ name: string; url: string; file: File } | null>(null)
  const [activeView, setActiveView] = useState<'studio' | 'settings'>('studio')
  const [gpuName, setGpuName] = useState('GPU detected locally')
  const [vramTotalMb, setVramTotalMb] = useState(0)
  const [vramUsedMb, setVramUsedMb] = useState<number | null>(null)
  const [topMenu, setTopMenu] = useState<'help' | 'account' | null>(null)
  const [outputDirectory, setOutputDirectory] = useState('D:\\Videos\\videocreation\\outputs')
  const [settingsMessage, setSettingsMessage] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const musicInputRef = useRef<HTMLInputElement>(null)

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
        const system = await fetch('http://127.0.0.1:41955/system').then((response) => response.json() as Promise<{ gpuName?: string; vramTotalMb?: number; vramUsedMb?: number | null }>)
        if (cancelled) return
        if (system.gpuName) setGpuName(system.gpuName)
        if (system.vramTotalMb) setVramTotalMb(system.vramTotalMb)
        setVramUsedMb(system.vramUsedMb ?? null)
      } catch {
        // The bridge may still be starting; WebGL remains the visible fallback.
      }
    }
    void loadSystemInfo()
    return () => { cancelled = true }
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

  const prepareReferenceImage = async (file: File, targetAspect: string) => {
    const image = new Image()
    image.src = URL.createObjectURL(file)
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Unable to read the reference image.'))
    })
    const [targetWidth, targetHeight] = targetAspect === '9:16' ? [1088, 1920] : [1920, 1088]
    const scale = Math.min(targetWidth / image.naturalWidth, targetHeight / image.naturalHeight)
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

  const createPromptFromRequest = () => {
    const request = requestText.trim()
    if (!request) {
      setGenerationMessage('Write what should happen in the video first.')
      return
    }
    const normalizedRequest = request.toLowerCase()
    const actions = [
      { matches: ['bacio', 'bacia', 'kiss'], text: 'The person gently smiles and sends a loving kiss toward the camera.' },
      { matches: ['saluta', 'salutare', 'wave'], text: 'The person gently raises one hand and waves slowly toward the camera.' },
      { matches: ['sorride', 'sorriso', 'smile'], text: 'The person smiles warmly and naturally.' },
      { matches: ['abbraccia', 'abbraccio', 'hug'], text: 'The people share a gentle, affectionate embrace.' },
      { matches: ['guarda', 'occhi', 'look'], text: 'The people look lovingly into each other\'s eyes.' },
      { matches: ['cane', 'cagnolina', 'dotty', 'dog'], text: 'The dog looks affectionately at the person and makes a small, natural movement.' },
      { matches: ['scala', 'scale', 'stairs'], text: 'The person moves naturally on the stairs while keeping the original composition believable.' },
    ]
    const selectedActions = actions.filter((action) => action.matches.some((match) => normalizedRequest.includes(match))).map((action) => action.text)
    const actionText = selectedActions.length > 0 ? selectedActions.join(' ') : 'Add subtle natural movement and a gentle, heartfelt expression.'
    const memorialText = ['mancata', 'scomparsa', 'non c\'è più', 'non c\'e piu', 'memoria', 'ricordo'].some((match) => normalizedRequest.includes(match))
      ? 'Treat this as a respectful living memory: preserve the person\'s identity and dignity, with no ghost effect, supernatural elements, or changes to facial features.'
      : ''
    setPrompt(`Create a tender, photorealistic memory from the reference image. ${request}. ${actionText} ${memorialText} Preserve every person\'s identity, face, age, hairstyle, clothing, body proportions, and the original background exactly. Add only natural blinking, breathing, small head and hand movements, and gentle movement in clothing and hair. Keep the camera locked and the composition unchanged. Smooth, respectful, emotionally warm animation. No zoom, no camera movement, no scene change.`.slice(0, 1000))
    setGenerationMessage('Prompt created from your request.')
  }

  const generateWithLtx = async (hasMusic = false) => {
    if (!referenceFile) throw new Error('Import an image before starting I2V.')
    if (!['16:9', '9:16'].includes(aspect)) throw new Error('LTX local I2V supports 16:9 and 9:16 only.')
    const imageData = await prepareReferenceImage(referenceFile, aspect)
    const wantsHandMotion = /mano|hand|wave|waving|salut/i.test(prompt)
    const motionPrompt = wantsHandMotion
      ? `${prompt}. Animate the raised hand slowly waving from side to side. Keep the camera locked and static: no zoom, no dolly, no pan, no crop, and no reframing.`
      : prompt
    const response = await fetch('http://127.0.0.1:41955/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData, hasMusic, wantsHandMotion, exportPreset, prompt: `${motionPrompt} Keep the father fully visible from head to body, with his entire head inside the frame. Do not crop, zoom in, or cut off the top of the head.`, duration: Number.parseInt(duration, 10), aspectRatio: aspect }),
    })
    const result = await response.json() as { data?: string; mimeType?: string; message?: string }
    if (!response.ok || !result.data || !result.mimeType) throw new Error(result.message ?? `LTX request failed (${response.status}).`)
    const media = result
    return `data:${media.mimeType};base64,${media.data}`
  }

  const generate = async () => {
    const selectedMusic = musicTrack
    if (exportPreset === 'facebook-reel' && selectedModel.name !== 'LTX Video') {
      setStatus('error')
      setGeneratedMedia(null)
      setGeneratedMediaIsVideo(false)
      setGenerationMessage('Facebook Reel export uses LTX Video to create an exact 1080 × 1920 MP4. Select LTX Video first.')
      return
    }
    if (selectedModel.name === 'LTX Video' && !referenceImage) {
      setStatus('error')
      setGeneratedMedia(null)
      setGeneratedMediaIsVideo(false)
      setGenerationMessage('Import an image first. LTX Video uses the selected image to create the animation.')
      return
    }
    if (referenceImage && selectedModel.name === 'Wan 2.1 · 1.3B') {
      setStatus('error')
      setGeneratedMedia(null)
      setGeneratedMediaIsVideo(false)
      setGenerationMessage('Reference images require the LTX Desktop I2V engine. Wan 2.1 · 1.3B is text-to-video only, so no unrelated video was created.')
      return
    }
    if (referenceImage && selectedModel.name === 'LTX Video') {
      setStatus('connecting')
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
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
    setGenerationMessage('Connecting to ComfyUI...')
    try {
      const workflow = await fetch('/wan_text_to_video_api.json').then((response) => response.json())
      workflow['6'].inputs.text = prompt
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

  const importImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setReferenceImage((currentImage) => {
      if (currentImage) URL.revokeObjectURL(currentImage)
      return URL.createObjectURL(file)
    })
    setReferenceFile(file)
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
    setGenerationMessage('')
    setStatus('idle')
    event.target.value = ''
  }

  const removeImage = () => {
    setReferenceImage((currentImage) => {
      if (currentImage) URL.revokeObjectURL(currentImage)
      return null
    })
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
    setGenerationMessage('Audio removed. The next video will use speech only.')
  }

  const startNewVideo = () => {
    setPrompt(examples[0].prompt)
    setSelectedModel(models[1])
    setDuration('5 sec')
    setAspect('9:16')
    setExportPreset('facebook-reel')
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
    setReferenceImage((currentImage) => {
      if (currentImage) URL.revokeObjectURL(currentImage)
      return null
    })
    setReferenceFile(null)
    setMusicTrack((currentTrack) => {
      if (currentTrack) URL.revokeObjectURL(currentTrack.url)
      return null
    })
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
    setGeneratedMedia(null)
    setGeneratedMediaIsVideo(false)
    setGenerationMessage('Audio selected. Generate the video to embed it.')
    event.target.value = ''
  }

  const fileToDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Unable to read the music file.'))
    reader.readAsDataURL(file)
  })

  const mixVideoWithMusic = async (videoUrl: string, track: { name: string; url: string; file: File } | null = musicTrack) => {
    if (!track) return videoUrl
    const response = await fetch('http://127.0.0.1:41955/mix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioData: await fileToDataUrl(track.file), ...(videoUrl.startsWith('data:') ? { videoData: videoUrl } : { videoUrl }) }),
    })
    const result = await response.json() as { data?: string; mimeType?: string; message?: string }
    if (!response.ok || !result.data || !result.mimeType) throw new Error(result.message ?? 'Unable to add music to the video.')
    return `data:${result.mimeType};base64,${result.data}`
  }

  const extendGeneratedVideo = async () => {
    if (!generatedMedia || !generatedMediaIsVideo) return
    setStatus('connecting')
    setGenerationMessage('Extending the video locally...')
    try {
      const response = await fetch('http://127.0.0.1:41955/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoData: generatedMedia, duration: Number(extensionDuration), prompt, aspectRatio: aspect, exportPreset }),
      })
      const result = await response.json() as { data?: string; mimeType?: string; message?: string }
      if (!response.ok || !result.data || !result.mimeType) throw new Error(result.message ?? 'Unable to extend the video.')
      const extendedMedia = `data:${result.mimeType};base64,${result.data}`
      setGenerationMessage(musicTrack ? 'Adding music to the extended video...' : 'Video extended.')
      setGeneratedMedia(await mixVideoWithMusic(extendedMedia, musicTrack))
      setStatus('idle')
      setGenerationMessage('Video extended.')
    } catch (error) {
      setStatus('error')
      setGenerationMessage(error instanceof Error ? error.message : 'Unable to extend the video.')
    }
  }

  return (
    <main className="app-shell">
      <nav className="topbar">
        <div className="brand" aria-label="motion"><span>mo</span>tion<span className="brand-dot">.</span></div>
        <div className="nav-links"><button className="active" onClick={() => setActiveView('studio')}>Studio</button></div>
        <div className="top-actions"><span className="local-pill" title="All generation stays on this computer"><i /> Local mode</span><button className="settings-top-button" onClick={() => setActiveView('settings')}><Settings2 size={15} /> Settings</button><div className="top-menu-wrap"><button className="icon-button" aria-label="Help" aria-expanded={topMenu === 'help'} onClick={() => setTopMenu((current) => current === 'help' ? null : 'help')}><CircleHelp size={18} /></button>{topMenu === 'help' && <div className="top-menu"><strong>Local studio</strong><span>Generation, media and audio stay on this computer.</span></div>}</div><div className="top-menu-wrap"><button className="avatar" aria-label="Account" aria-expanded={topMenu === 'account'} onClick={() => setTopMenu((current) => current === 'account' ? null : 'account')}>R</button>{topMenu === 'account' && <div className="top-menu account-menu"><strong>Local account</strong><span>R</span></div>}</div></div>
      </nav>

      <section className="workspace">
        <aside className="sidebar">
          {activeView === 'studio' && <div className="studio-controls">
            <div className="request-card"><div className="prompt-top"><span className="prompt-label">YOUR REQUEST</span><span className="prompt-count">{requestText.length} / 500</span></div><textarea value={requestText} onChange={(event) => setRequestText(event.target.value)} maxLength={500} placeholder="Describe what should happen..." spellCheck={false} /><button className="magic-button" onClick={createPromptFromRequest}><Sparkles size={16} /> Create prompt</button></div>
            <div className="prompt-card"><div className="prompt-top"><span className="prompt-label">PROMPT</span><span className="prompt-count">{prompt.length} / 1,000</span></div><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} spellCheck={false} /><div className="prompt-bottom"><button className="magic-button" onClick={() => setPrompt(examples[Math.floor(Math.random() * examples.length)].prompt)}><WandSparkles size={16} /> Inspire me</button></div></div>
            <div className="music-control canvas-music-control"><input ref={musicInputRef} type="file" accept="audio/*" onChange={importMusic} /><button className="music-button" onClick={() => musicInputRef.current?.click()}><Music2 size={16} /> {musicTrack ? 'Change music' : 'Insert audio'}</button>{musicTrack && <><span title={musicTrack.name}>{musicTrack.name}</span><button className="remove-music" onClick={removeMusic} aria-label="Remove selected music" title="Remove music"><X size={14} /></button></>}</div>{musicTrack && !generatedMedia && <audio className="music-player" src={musicTrack.url} controls />}
            <div className="controls"><label><span>EXPORT PRESET</span><div className="select-control-wrap"><select className="select-control" value={exportPreset} onChange={(event) => { const nextPreset = event.target.value; setExportPreset(nextPreset); if (nextPreset === 'facebook-reel') { setAspect('9:16'); setDuration('5 sec') } }}><option value="facebook-reel">Facebook Reel · 1080 × 1920</option><option value="original">Original format</option></select><span className="select-chevron">⌄</span></div></label><label><span>MODEL</span><div className="select-control-wrap"><span className={`model-mark ${selectedModel.color}`}><Layers3 size={13} /></span><select className="select-control model-select" value={selectedModel.name} onChange={(event) => setSelectedModel(models.find((model) => model.name === event.target.value) ?? models[0])}>{models.map((model) => <option key={model.name} value={model.name} disabled={!model.installed}>{model.name}{model.installed ? '' : ' · not installed'}</option>)}</select><span className="select-chevron">⌄</span></div></label><label><span>DURATION</span><div className="select-control-wrap"><select className="select-control" value={duration} onChange={(event) => setDuration(event.target.value)}><option>3 sec</option><option>5 sec</option><option>8 sec</option><option>10 sec</option></select><span className="select-chevron">⌄</span></div></label><label><span>FORMAT</span><div className="select-control-wrap"><select className="select-control" value={aspect} onChange={(event) => setAspect(event.target.value)}><option>16:9</option><option>9:16</option><option>3:4</option><option>1:1</option></select><span className="select-chevron">⌄</span></div></label></div>
            <button className="generate-button" onClick={generate} disabled={status === 'connecting'}>{status === 'connecting' ? <><LoaderCircle className="spin" size={19} /> {selectedModel.name === 'LTX Video' ? 'Generating with LTX Desktop...' : 'Connecting to ComfyUI...'}</> : <><Sparkles size={18} /> Generate video <ArrowUpRight size={18} /></>}</button>
            {generationMessage && <p className={`generation-message ${status === 'error' ? 'error' : ''}`}>{generationMessage}</p>}
          </div>}
          <div className="side-divider" />
          <div className="side-footer"><div className="gpu-label"><span className="green-dot" /> GPU ready</div><p title={gpuName}>{gpuName}</p><small>{vramTotalMb > 0 ? `${(vramTotalMb / 1024).toFixed(1)} GB VRAM${vramUsedMb !== null ? ` · ${(vramUsedMb / 1024).toFixed(1)} GB in use` : ''}` : 'VRAM detection unavailable'}</small></div>
        </aside>

        {activeView === 'settings' && <div className="utility-panel"><div className="utility-head"><div><p className="section-kicker">PREFERENCES</p><h2>Settings</h2></div><button className="text-button" onClick={() => setActiveView('studio')}>Back to Studio</button></div><div className="settings-list"><label><span>ENGINE</span><strong>Local GPU rendering</strong></label><label className="settings-path"><span>VIDEO OUTPUT</span><div><div className="path-controls"><input value={outputDirectory} onChange={(event) => setOutputDirectory(event.target.value)} aria-label="Video output directory" /><button className="pick-directory" onClick={pickOutputDirectory}><FolderOpen size={14} /> Browse</button></div><button className="save-settings" onClick={saveSettings}>Save path</button>{settingsMessage && <small>{settingsMessage}</small>}</div></label><label><span>ACTIVE MODEL</span><strong>{selectedModel.name}</strong></label></div></div>}
        <div className="canvas-area">
          <div className="canvas-head"><div><p className="section-kicker">NEW PROJECT</p><h2>Describe your shot</h2></div><div className="canvas-actions"><button className="new-video-button" onClick={startNewVideo}><Plus size={15} /> New video</button><div className="import-control"><input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={importImage} /><button className="text-button" onClick={() => fileInputRef.current?.click()}><Film size={16} /> {referenceImage ? 'Change image' : 'Import image'}</button>{referenceImage && <button className="remove-image" onClick={removeImage} aria-label="Remove imported image"><X size={14} /></button>}</div></div></div>
          <div className="media-grid">
            {referenceImage && <div className="reference-image"><img src={referenceImage} alt="Imported reference" /><span>REFERENCE IMAGE</span></div>}
            <section className="center-preview"><div className="preview-head"><span>PREVIEW</span><span className="render-status"><i /> {generatedMedia ? 'Complete' : status === 'connecting' ? 'Rendering' : 'Ready'}</span></div><div className={`preview-frame ${aspect === '9:16' ? 'portrait-preview' : ''}`} style={{ aspectRatio: aspect === '9:16' ? '9 / 16' : '16 / 9' }}>{generatedMedia ? generatedMediaIsVideo ? <video className="generated-video" src={generatedMedia} controls autoPlay loop /> : <img className="generated-video" src={generatedMedia} alt="Generated video preview" /> : <><div className="preview-grid" /><div className="preview-placeholder"><div className="play-ring"><Play size={17} fill="currentColor" /></div><span>Your next shot<br /><b>will live here</b></span></div><span className="frame-corner top-left" /><span className="frame-corner top-right" /><span className="frame-corner bottom-left" /><span className="frame-corner bottom-right" /></>}</div>{generatedMedia && <div className="preview-actions"><a className="download-button" href={generatedMedia} download={exportPreset === 'facebook-reel' ? 'facebook-reel-1080x1920.mp4' : 'motion-render.mp4'} title="Download video"><Download size={16} /> Download {exportPreset === 'facebook-reel' ? 'Facebook video' : 'video'}</a><div className="extend-control"><select value={extensionDuration} onChange={(event) => setExtensionDuration(event.target.value)} aria-label="Additional video duration"><option value="5">+5 sec</option><option value="10">+10 sec</option><option value="20">+20 sec</option></select><button className="extend-button" onClick={extendGeneratedVideo} disabled={status === 'connecting'}>Extend</button></div><button className="delete-button" onClick={removeVideo} title="Delete video"><Trash2 size={16} /> Delete</button></div>}<div className="preview-note"><Gauge size={15} /><span>{exportPreset === 'facebook-reel' ? 'Facebook Reel · 1080 × 1920 · MP4' : 'Rendered locally on your GPU'}</span></div></section>
          </div>
        </div>

      </section>
      <footer><span>motion / v0.1 alpha</span><span>Open weights, open possibilities.</span></footer>
    </main>
  )
}

export default App
