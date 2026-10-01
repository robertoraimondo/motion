import { createServer, request as httpRequest } from 'node:http'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { promisify } from 'node:util'

const port = 41955
const backendUrl = 'http://127.0.0.1:41954'
const authToken = process.env.LTX_AUTH_TOKEN || 'motion-local-token'
const uploadDirectory = path.join(os.tmpdir(), 'motion-ltx')
const configFilePath = process.env.MOTION_CONFIG_FILE || path.join(process.cwd(), 'motion-config.json')
const logFilePath = path.join(path.dirname(configFilePath), 'bridge.log')
let outputDirectory = process.env.MOTION_OUTPUT_DIRECTORY || 'D:\\Videos\\videocreation\\outputs'
const execFileAsync = promisify(execFile)
let activeBackendRequest = null
let activeGeneration = null

const send = (response, status, body) => {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  response.end(JSON.stringify(body))
}

const readJson = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const logError = async (scope, error) => {
  const cause = error instanceof Error && error.cause ? `\nCause: ${error.cause.code || error.cause.message || String(error.cause)}` : ''
  const message = error instanceof Error ? `${error.message}${cause}\n${error.stack || ''}` : String(error)
  await appendFile(logFilePath, `[${new Date().toISOString()}] ${scope}: ${message}\n`)
}

const postJson = async (url, headers, body) => {
  const target = new URL(url)
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const request = httpRequest({
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(body), Connection: 'close' },
          timeout: 30 * 60 * 1000,
        }, (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => { if (activeBackendRequest === request) activeBackendRequest = null; resolve({ status: response.statusCode || 500, body: Buffer.concat(chunks).toString('utf8') }) })
          response.on('error', reject)
        })
        activeBackendRequest = request
        request.on('timeout', () => request.destroy(new Error('LTX request timed out.')))
        request.on('error', (error) => { if (activeBackendRequest === request) activeBackendRequest = null; reject(error) })
        request.end(body)
      })
    } catch (error) {
      if (error?.code !== 'ECONNREFUSED' || attempt === 89) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error('LTX request failed.')
}

const cancelLtxGeneration = () => new Promise((resolve) => {
  const target = new URL(`${backendUrl}/api/generate/cancel`)
  const request = httpRequest({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Length': 0, Connection: 'close' },
    timeout: 10000,
  }, (response) => {
    response.resume()
    response.on('end', () => resolve(response.statusCode >= 200 && response.statusCode < 300))
  })
  request.on('timeout', () => request.destroy(new Error('LTX cancellation timed out.')))
  request.on('error', () => resolve(false))
  request.end()
})

const loadConfig = async () => {
  try {
    const config = JSON.parse(await readFile(configFilePath, 'utf8'))
    if (typeof config.outputDirectory === 'string' && path.isAbsolute(config.outputDirectory)) outputDirectory = config.outputDirectory
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const listVideos = async () => {
  await mkdir(outputDirectory, { recursive: true })
  return (await readdir(outputDirectory)).filter((file) => file.toLowerCase().endsWith('.mp4'))
}

const writeDataUrl = async (dataUrl, filePath) => {
  const match = /^data:[^;]+;base64,(.+)$/.exec(dataUrl || '')
  if (!match) throw new Error('Invalid media data.')
  await writeFile(filePath, Buffer.from(match[1], 'base64'))
}

const facebookDimensions = {
  'facebook-feed': [1080, 1350],
  'facebook-reel': [1080, 1920],
  'facebook-landscape': [1920, 1080],
}

const normalizeFacebookVideo = async (sourcePath, outputPath, preset, duration = undefined) => {
  const [width, height] = facebookDimensions[preset] || facebookDimensions['facebook-reel']
  const args = ['-y', '-i', sourcePath, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`, '-r', '30', '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
  if (duration) args.push('-t', String(duration))
  args.push(outputPath)
  await execFileAsync('ffmpeg', args)
}

const generateImageSequence = async (body, generation) => {
  const images = Array.isArray(body.images) ? body.images : []
  if (images.length < 2) throw new Error('Select at least two images to create a sequence.')
  if (images.length > 20) throw new Error('A sequence can contain up to 20 images.')
  const duration = Number(body.duration)
  if (!Number.isFinite(duration) || duration < 1 || duration > 30) throw new Error('Each sequence image must be between 1 and 30 seconds.')
  const id = randomUUID()
  const temporaryFiles = []
  const segmentFiles = []
  const sequencePath = path.join(uploadDirectory, `${id}-sequence.mp4`)
  temporaryFiles.push(sequencePath)
  await mkdir(uploadDirectory, { recursive: true })
  const [frameWidth, frameHeight] = body.exportPreset?.startsWith('facebook-')
    ? facebookDimensions[body.exportPreset] || facebookDimensions['facebook-reel']
    : body.aspectRatio === '9:16' ? [720, 1280] : [1280, 720]
  const transitionDuration = 0.4
  try {
    for (let index = 0; index < images.length; index += 1) {
      if (generation.cancelled) return null
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(images[index] || '')
      if (!match) throw new Error(`Sequence image ${index + 1} is not a valid image.`)
      const extension = match[1].split('/')[1].replace('jpeg', 'jpg')
      const imagePath = path.join(uploadDirectory, `${id}-${index + 1}.${extension}`)
      const rawVideoPath = path.join(uploadDirectory, `${id}-${index + 1}-raw.mp4`)
      const segmentPath = path.join(uploadDirectory, `${id}-${index + 1}-segment.mp4`)
      temporaryFiles.push(imagePath, rawVideoPath, segmentPath)
      segmentFiles.push(segmentPath)
      await writeFile(imagePath, Buffer.from(match[2], 'base64'))
      const requestedMotion = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      const motionPrompt = `${requestedMotion ? `${requestedMotion}. ` : ''}Animate only the people in this single reference photo with gentle, natural movement: a soft blink, subtle breathing, and a small warm smile. Preserve each person's identity, facial features, and exact age as shown in this specific photo. Keep the original clothing, number of people, composition, and background. No new people, no missing people, no face blending, no collage, no split screen, no scene change. Keep the camera fixed with no zoom or reframing.`
      const ltxResponse = await postJson(`${backendUrl}/api/generate`, { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, JSON.stringify({ prompt: motionPrompt, negativePrompt: 'identity change, face morphing, age change, different people, extra people, missing people, collage, split screen, scene change, camera movement, zoom, crop, reframing, distorted faces, distorted hands, text, watermark', cameraMotion: 'none', duration, resolution: '720p', model: 'fast', fps: 24, aspectRatio: body.aspectRatio === '4:5' ? '9:16' : body.aspectRatio, imagePath }))
      if (generation.cancelled) return null
      const result = JSON.parse(ltxResponse.body)
      if (ltxResponse.status < 200 || ltxResponse.status >= 300 || result.status !== 'complete' || !result.video_path) throw new Error(result.message || `LTX could not animate image ${index + 1}.`)
      if (body.exportPreset?.startsWith('facebook-')) {
        await normalizeFacebookVideo(result.video_path, segmentPath, body.exportPreset, duration)
      } else {
        await execFileAsync('ffmpeg', ['-y', '-i', result.video_path, '-vf', `scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=decrease,pad=${frameWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2`, '-t', String(duration), '-r', '30', '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', segmentPath])
      }
      await rm(result.video_path, { force: true })
    }
    if (generation.cancelled) return null
    const ffmpegArgs = ['-y']
    for (const segmentPath of segmentFiles) ffmpegArgs.push('-i', segmentPath)
    const filters = segmentFiles.map((_, index) => `[${index}:v]fps=30,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${index}]`)
    let previous = 'v0'
    for (let index = 1; index < images.length; index += 1) {
      const output = `xf${index}`
      const offset = (duration - transitionDuration) * index
      filters.push(`[${previous}][v${index}]xfade=transition=fadeblack:duration=${transitionDuration}:offset=${offset}[${output}]`)
      previous = output
    }
    ffmpegArgs.push('-filter_complex', filters.join(';'), '-map', `[${previous}]`, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', sequencePath)
    await execFileAsync('ffmpeg', ffmpegArgs)
    const video = await readFile(sequencePath)
    await mkdir(outputDirectory, { recursive: true })
    const filename = body.exportPreset?.startsWith('facebook-') ? `${body.exportPreset}-sequence-${Date.now()}.mp4` : `motion-sequence-${Date.now()}.mp4`
    await copyFile(sequencePath, path.join(outputDirectory, filename))
    return { mimeType: 'video/mp4', data: video.toString('base64') }
  } finally {
    await Promise.all(temporaryFiles.map((file) => rm(file, { force: true })))
  }
}

const familyAffectionNegativePrompt = 'sisters kissing on the lips, sisters lip-to-lip kiss, sibling mouth kiss, family members kissing on the lips, father kissing bride on the lips, father kissing daughter on the lips, father-daughter mouth kiss, lip contact between family members, lip-to-lip kiss, mouth kiss, kissing on the mouth, open-mouth kiss, romantic behavior, incest, inappropriate intimacy'

const explicitlyRequestsLipKissing = (prompt = '') => {
  const requestsLipKiss = /\b(?:kiss(?:es|ing)?|baci(?:arsi|ano|a|are)?|bacio)\b.{0,50}\b(?:lips?|mouth|labbra|bocca)\b|\b(?:lips?|mouth|labbra|bocca)\b.{0,50}\b(?:kiss(?:es|ing)?|baci(?:arsi|ano|a|are)?|bacio)\b/i.test(prompt)
  const forbidsLipKiss = /\b(?:no|not|never|without|avoid|don't|do not|must not|must never|non|mai|nessun[oa]?|evita)\b.{0,35}\b(?:lip-to-lip|kiss(?:es|ing)?|baci(?:arsi|ano|a|are)?|bacio|lips?|mouth|labbra|bocca)\b/i.test(prompt)
  return requestsLipKiss && !forbidsLipKiss
}

const mixVideoWithMusic = async (body) => {
  const id = randomUUID()
  const videoPath = path.join(uploadDirectory, `${id}-video.input`)
  const audioPath = path.join(uploadDirectory, `${id}-music.input`)
  const mixedPath = path.join(outputDirectory, `motion-${id}.mp4`)
  try {
    await mkdir(uploadDirectory, { recursive: true })
    await mkdir(outputDirectory, { recursive: true })
    if (body.videoData) await writeDataUrl(body.videoData, videoPath)
    else if (body.videoUrl) {
      const videoResponse = await fetch(body.videoUrl)
      if (!videoResponse.ok) throw new Error('Unable to read the generated video.')
      await writeFile(videoPath, Buffer.from(await videoResponse.arrayBuffer()))
    } else throw new Error('The generated video is missing.')
    await writeDataUrl(body.audioData, audioPath)
    const trimStart = Math.max(0, Number(body.trimStart) || 0)
    await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-ss', String(trimStart), '-i', audioPath, '-filter_complex', '[1:a:0]apad[aout]', '-map', '0:v:0', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', mixedPath])
    const video = await readFile(mixedPath)
    return { mimeType: 'video/mp4', data: video.toString('base64') }
  } finally {
    await rm(videoPath, { force: true })
    await rm(audioPath, { force: true })
  }
}

const generateContinuation = async (videoPath, duration, prompt, aspectRatio, id, preserveComposition = false) => {
  const extractedFramePath = path.join(uploadDirectory, `${id}-last-frame.png`)
  const framePath = preserveComposition ? path.join(uploadDirectory, `${id}-continuation-input.png`) : extractedFramePath
  const continuationPath = path.join(uploadDirectory, `${id}-continuation.mp4`)
  const { stdout: dimensionsOutput } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', videoPath])
  const [sourceWidth, sourceHeight] = dimensionsOutput.trim().split('x').map(Number)
  await execFileAsync('ffmpeg', ['-y', '-sseof', '-0.1', '-i', videoPath, '-frames:v', '1', extractedFramePath])
  if (preserveComposition) {
    await execFileAsync('ffmpeg', ['-y', '-i', extractedFramePath, '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black', '-frames:v', '1', framePath])
  }
  const imageData = `data:image/png;base64,${(await readFile(framePath)).toString('base64')}`
  const generationAspect = aspectRatio === '4:5' ? '9:16' : aspectRatio
  const ltxResponse = await postJson(`${backendUrl}/api/generate`, { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, JSON.stringify({
    prompt: `${prompt || 'Continue the natural movement smoothly from the final frame.'} Continue seamlessly from the starting image. Preserve the people, faces, clothes, setting, camera framing, and exact size of every person in frame. Do not pull back or make the group smaller.`,
    negativePrompt: `${explicitlyRequestsLipKissing(prompt) ? '' : `${familyAffectionNegativePrompt}, `}scene change, camera movement, zoom, zoom out, dolly, pan, crop, reframing, pull back, shrinking subjects, smaller people, identity change, distorted faces, distorted hands`,
    cameraMotion: 'none',
    duration,
    resolution: '720p',
    model: 'fast',
    fps: 24,
    aspectRatio: generationAspect,
    imageData,
    imagePath: framePath,
  }))
  const result = JSON.parse(ltxResponse.body)
  if (ltxResponse.status < 200 || ltxResponse.status >= 300 || result.status !== 'complete' || !result.video_path) throw new Error(result.message || 'Unable to generate the continuation.')
  await copyFile(result.video_path, continuationPath)
  await rm(result.video_path, { force: true })
  const continuationFilter = preserveComposition
    ? `[1:v:0]scale=${sourceWidth}:${sourceHeight}:force_original_aspect_ratio=increase,crop=${sourceWidth}:${sourceHeight}[v1];[0:v:0][v1]concat=n=2:v=1:a=0[v]`
    : `[1:v:0]scale=${sourceWidth}:${sourceHeight}:force_original_aspect_ratio=decrease,pad=${sourceWidth}:${sourceHeight}:(ow-iw)/2:(oh-ih)/2[v1];[0:v:0][v1]concat=n=2:v=1:a=0[v]`
  await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-i', continuationPath, '-filter_complex', continuationFilter, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${id}-joined.mp4`], { cwd: uploadDirectory })
  const joinedPath = path.join(uploadDirectory, `${id}-joined.mp4`)
  await rm(continuationPath, { force: true })
  await rm(framePath, { force: true })
  if (framePath !== extractedFramePath) await rm(extractedFramePath, { force: true })
  return joinedPath
}

const extendVideo = async (body) => {
  const id = randomUUID()
  const videoPath = path.join(uploadDirectory, `${id}-extend.input.mp4`)
  try {
    await mkdir(uploadDirectory, { recursive: true })
    await writeDataUrl(body.videoData, videoPath)
    const requestedDuration = Number(body.duration)
    const preserveComposition = body.exportPreset === 'facebook-feed' || body.aspectRatio === '4:5'
    const extendResponse = await postJson(`${backendUrl}/api/extend`, { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, JSON.stringify({ video_path: videoPath, duration: requestedDuration, prompt: body.prompt || '', mode: 'end' }))
    const result = JSON.parse(extendResponse.body)
    let resultPath = result.video_path
    if (extendResponse.status === 409) {
      resultPath = videoPath
      let remainingDuration = requestedDuration
      let part = 0
      while (remainingDuration > 0) {
        const nextDuration = Math.min(remainingDuration, 10)
        const nextPath = await generateContinuation(resultPath, nextDuration, body.prompt, body.aspectRatio || '16:9', `${id}-${part}`, preserveComposition)
        if (resultPath !== videoPath) await rm(resultPath, { force: true })
        resultPath = nextPath
        remainingDuration -= nextDuration
        part += 1
      }
    }
    if (!resultPath || (extendResponse.status !== 200 && !resultPath)) throw new Error(result.message || result.detail || 'LTX rejected the video extension.')
    const outputPath = body.exportPreset?.startsWith('facebook-') ? path.join(uploadDirectory, `${randomUUID()}-facebook-extended.mp4`) : resultPath
    if (body.exportPreset?.startsWith('facebook-')) await normalizeFacebookVideo(resultPath, outputPath, body.exportPreset)
    const video = await readFile(outputPath)
    await rm(resultPath, { force: true })
    if (outputPath !== resultPath) await rm(outputPath, { force: true })
    return { mimeType: 'video/mp4', data: video.toString('base64') }
  } finally {
    await rm(videoPath, { force: true })
  }
}

const latestVideo = async () => {
  const files = await listVideos()
  const withStats = await Promise.all(files.map(async (file) => ({ file, modified: (await stat(path.join(outputDirectory, file))).mtimeMs })))
  const latest = withStats.sort((left, right) => right.modified - left.modified)[0]
  if (!latest) return null
  const video = await readFile(path.join(outputDirectory, latest.file))
  return { mimeType: 'video/mp4', data: video.toString('base64') }
}

const projectSummary = async () => ({ outputDirectory, count: (await listVideos()).length })

const systemSummary = async () => {
  try {
    const { stdout } = await execFileAsync('nvidia-smi.exe', ['--query-gpu=name,memory.total,memory.used,fan.speed,temperature.gpu', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 })
    const [name, total, used, fanSpeed, temperature] = stdout.trim().split(',').map((value) => value.trim())
    if (name && total) return { gpuName: name, vramTotalMb: Number(total), vramUsedMb: Number(used) || 0, fanSpeedPercent: Number(fanSpeed), gpuTemperatureC: Number(temperature) }
  } catch {
    // nvidia-smi is not always on PATH, so use the Windows GPU provider below.
  }
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -gt 0 } | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 5000 })
  const fallback = JSON.parse(stdout.trim())
  return { gpuName: fallback.Name || 'GPU detected locally', vramTotalMb: Math.round(Number(fallback.AdapterRAM || 0) / 1024 / 1024), vramUsedMb: null, fanSpeedPercent: null, gpuTemperatureC: null }
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    })
    response.end()
    return
  }
  if (request.method === 'GET' && request.url === '/latest') {
    try {
      const video = await latestVideo()
      send(response, 200, video ?? {})
    } catch (error) {
      send(response, 404, { message: error instanceof Error ? error.message : 'No local video found.' })
    }
    return
  }
  if (request.method === 'GET' && request.url === '/config') {
    send(response, 200, { outputDirectory })
    return
  }
  if (request.method === 'GET' && request.url === '/projects') {
    try {
      send(response, 200, await projectSummary())
    } catch (error) {
      send(response, 500, { message: error instanceof Error ? error.message : 'Unable to read local projects.' })
    }
    return
  }
  if (request.method === 'GET' && request.url === '/system') {
    try {
      send(response, 200, await systemSummary())
    } catch (error) {
      send(response, 200, { gpuName: 'GPU detected locally', vramTotalMb: 0, vramUsedMb: null })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/pick-directory') {
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "Select the video output folder"; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }'])
      const selectedPath = stdout.trim()
      if (!selectedPath) {
        send(response, 200, { cancelled: true })
        return
      }
      send(response, 200, { outputDirectory: path.normalize(selectedPath) })
    } catch (error) {
      await logError('pick-directory', error)
      send(response, 500, { message: error instanceof Error ? error.message : 'Unable to open the folder picker.' })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/config') {
    try {
      const body = await readJson(request)
      if (typeof body.outputDirectory !== 'string' || !path.isAbsolute(body.outputDirectory)) throw new Error('Enter an absolute video output path.')
      outputDirectory = path.normalize(body.outputDirectory)
      await mkdir(outputDirectory, { recursive: true })
      await writeFile(configFilePath, JSON.stringify({ outputDirectory }, null, 2))
      send(response, 200, { outputDirectory })
    } catch (error) {
      await logError('config', error)
      send(response, 400, { message: error instanceof Error ? error.message : 'Unable to save output path.' })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/mix') {
    try {
      const result = await mixVideoWithMusic(await readJson(request))
      send(response, 200, result)
    } catch (error) {
      send(response, 502, { message: error instanceof Error ? error.message : 'Audio mix failed.' })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/cancel') {
    const backendCancelled = await cancelLtxGeneration()
    const generation = activeGeneration
    if (generation) generation.cancelled = true
    if (activeBackendRequest) {
      activeBackendRequest.destroy(new Error('Generation cancelled by user.'))
      activeBackendRequest = null
    }
    if (generation?.response && !generation.response.writableEnded) send(generation.response, 409, { message: 'Generation cancelled by user.' })
    if (activeGeneration === generation) activeGeneration = null
    send(response, 200, { cancelled: true, backendCancelled })
    return
  }
  if (request.method === 'POST' && request.url === '/extend') {
    try {
      const result = await extendVideo(await readJson(request))
      send(response, 200, result)
    } catch (error) {
      await logError('extend', error)
      send(response, 502, { message: error instanceof Error ? error.message : 'Video extension failed.' })
    }
    return
  }
  if (request.method === 'POST' && request.url === '/sequence') {
    if (activeGeneration && !activeGeneration.response.writableEnded) {
      send(response, 409, { message: 'Generation already in progress.' })
      return
    }
    const generation = { response, cancelled: false }
    activeGeneration = generation
    response.on('close', () => {
      if (response.writableEnded || generation.cancelled) return
      generation.cancelled = true
      if (activeGeneration === generation) activeGeneration = null
      if (activeBackendRequest) {
        activeBackendRequest.destroy(new Error('Sequence generation client disconnected.'))
        activeBackendRequest = null
      }
    })
    try {
      const result = await generateImageSequence(await readJson(request), generation)
      if (!generation.cancelled && result) send(response, 200, result)
    } catch (error) {
      if (generation.cancelled || response.writableEnded) return
      await logError('sequence', error)
      send(response, 502, { message: error instanceof Error ? error.message : 'Image sequence generation failed.' })
    } finally {
      if (activeGeneration === generation) activeGeneration = null
    }
    return
  }
  if (request.method !== 'POST' || request.url !== '/generate') {
    send(response, 404, { message: 'Not found' })
    return
  }

  let filePath
  if (activeGeneration && !activeGeneration.response.writableEnded) {
    send(response, 409, { message: 'Generation already in progress.' })
    return
  }
  const generation = { response, cancelled: false }
  activeGeneration = generation
  response.on('close', () => {
    if (response.writableEnded || generation.cancelled) return
    generation.cancelled = true
    if (activeGeneration === generation) activeGeneration = null
    if (activeBackendRequest) {
      activeBackendRequest.destroy(new Error('Generation client disconnected.'))
      activeBackendRequest = null
    }
  })
  try {
    const body = await readJson(request)
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(body.imageData || '')
    if (!match) throw new Error('The reference image must be PNG, JPEG, or WebP.')
    const generationAspect = body.aspectRatio === '4:5' ? '9:16' : body.aspectRatio
    if (!['16:9', '9:16'].includes(generationAspect)) throw new Error('LTX local I2V supports 16:9 and 9:16 only.')
    await mkdir(uploadDirectory, { recursive: true })
    const extension = match[1].split('/')[1].replace('jpeg', 'jpg')
    filePath = path.join(uploadDirectory, `${randomUUID()}.${extension}`)
    await writeFile(filePath, Buffer.from(match[2], 'base64'))
    const duration = Number(body.duration)
    const resolution = '720p'
    const relationshipNegativePrompt = explicitlyRequestsLipKissing(body.prompt) ? '' : `${familyAffectionNegativePrompt}, `
    const ltxResponse = await postJson(`${backendUrl}/api/generate`, { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, JSON.stringify({ prompt: body.prompt, negativePrompt: `${relationshipNegativePrompt}${body.wantsHandMotion ? 'camera movement, zoom, dolly, pan, crop, reframing, scene change' : 'scene change, distorted faces, distorted hands'}`, cameraMotion: body.wantsHandMotion ? 'none' : undefined, duration, resolution, model: 'fast', fps: 24, aspectRatio: generationAspect, imagePath: filePath }))
    if (generation.cancelled) return
    const result = JSON.parse(ltxResponse.body)
    if (ltxResponse.status < 200 || ltxResponse.status >= 300 || result.status !== 'complete' || !result.video_path) throw new Error(result.message || 'LTX rejected the generation request.')
    const outputPath = body.exportPreset?.startsWith('facebook-') ? path.join(uploadDirectory, `${randomUUID()}-facebook.mp4`) : result.video_path
    if (body.exportPreset?.startsWith('facebook-')) await normalizeFacebookVideo(result.video_path, outputPath, body.exportPreset)
    const video = await readFile(outputPath)
    if (!body.hasMusic) {
      await mkdir(outputDirectory, { recursive: true })
      await copyFile(outputPath, path.join(outputDirectory, body.exportPreset?.startsWith('facebook-') ? `${body.exportPreset}-${Date.now()}.mp4` : path.basename(result.video_path)))
    }
    await rm(result.video_path, { force: true })
    if (outputPath !== result.video_path) await rm(outputPath, { force: true })
    send(response, 200, { mimeType: 'video/mp4', data: video.toString('base64') })
  } catch (error) {
    if (generation.cancelled || response.writableEnded) return
    await logError('generate', error)
    if (!response.writableEnded) send(response, 502, { message: error instanceof Error ? error.message : 'LTX bridge failed.' })
  } finally {
    if (filePath) await rm(filePath, { force: true })
    if (activeGeneration === generation) activeGeneration = null
  }
})

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') process.exit(0)
  await logError('server', error)
  process.exit(1)
})

loadConfig().then(() => mkdir(outputDirectory, { recursive: true })).then(() => server.listen(port, '127.0.0.1'))
