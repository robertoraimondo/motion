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

const postJson = async (url, headers, body, maxConnectionAttempts = 90) => {
  const target = new URL(url)
  for (let attempt = 0; attempt < maxConnectionAttempts; attempt += 1) {
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
      if (error?.code !== 'ECONNREFUSED' || attempt === maxConnectionAttempts - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error('LTX request failed.')
}

const translatePromptLocally = async (prompt) => {
  const translationRequest = [
    'Translate the following video-generation prompt from Italian into natural, concise English.',
    'Preserve the user’s requested actions, subjects, timing, and constraints exactly.',
    'Do not add new actions, subjects, setting details, or camera movements.',
    'Return only the English translation as one paragraph.',
    '',
    'Italian prompt:',
    prompt,
  ].join('\n')
  const response = await postJson(
    `${backendUrl}/api/enhance-prompt`,
    { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    JSON.stringify({ prompt: translationRequest, provider: 'local', mediaType: 'video' }),
  )
  const result = JSON.parse(response.body)
  if (response.status < 200 || response.status >= 300 || typeof result.enhancedPrompt !== 'string' || !result.enhancedPrompt.trim()) {
    throw new Error(result.detail || result.message || 'Local prompt translation failed.')
  }
  return result.enhancedPrompt.trim()
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
  const args = ['-y', '-i', sourcePath, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`, '-r', '30', '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
  if (duration) args.push('-t', String(duration))
  args.push(outputPath)
  await execFileAsync('ffmpeg', args)
}

const explicitlyForbidsKissing = (prompt = '') => /\b(?:no|never|without|avoid|don't|do not|must not|must never)\b.{0,45}\b(?:kiss(?:es|ing)?|lip-to-lip|lips? touching|mouths? touching)\b|\b(?:non|mai|senza|evita|non devono|non deve)\b.{0,45}\b(?:baci(?:arsi|ano|a|are)?|bacio|labbra a contatto|bocche a contatto)\b/i.test(prompt)

const cleanPositiveMotionPrompt = (requestedAction = '') => {
  const requestedKissBan = explicitlyForbidsKissing(requestedAction)
  const sentences = requestedAction.trim().split(/(?<=[.!?])\s+/)
  const cleaned = requestedKissBan
    ? sentences.filter((sentence) => !explicitlyForbidsKissing(sentence)).join(' ')
    : requestedAction.trim()
  return cleaned
    .replace(/\b(?:no|never|without|avoid|don't|do not|must not|must never)\s+(?:any\s+)?(?:zoom(?:ing)?|camera movement|camera motion)\b/gi, ' ')
    .replace(/\b(?:niente|nessun[oa]?|senza|non|evita)\s+(?:fare\s+)?(?:lo\s+)?(?:zoom|movimento della camera|movimento di camera)\b/gi, ' ')
    .replace(/\b(?:and|e)?\s*(?:no|never|without|avoid|don't|do not|must not|must never)\s+(?:any\s+)?(?:change|changes|changing)\s+(?:to\s+)?(?:the\s+)?(?:face|faces|identity|identities)\b/gi, ' ')
    .replace(/\b(?:e|and)?\s*(?:cambiamento|cambiamenti|modifica|modifiche)\s+(?:(?:del|dei|delle|di)\s+)?(?:volto|volti|faccia|facce|identità)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;])/g, '$1')
    .trim()
}

const buildImageMotionPrompt = (requestedAction = '') => {
  const action = cleanPositiveMotionPrompt(requestedAction) || 'Animate the existing subjects with clearly visible, natural movement throughout the clip.'
  const noFaceApproachConstraint = explicitlyForbidsKissing(requestedAction)
    ? 'Keep both heads and faces fixed in their original positions and orientations; animate only arms and shoulders, maintaining the existing space between faces.'
    : ''
  return `${action} Make the requested subject movements clearly visible and continuous from the first frame to the last; show purposeful body movement, not only blinking or breathing. ${noFaceApproachConstraint} Preserve the original people, identities, ages, clothing, positions, and background. The camera is locked off on a tripod; framing and subject scale remain constant for the entire clip. The people are the source of motion, not the camera.`.replace(/\s+/g, ' ').trim()
}

const buildImageNegativePrompt = (requestedAction = '') => {
  const requestedNoKiss = explicitlyForbidsKissing(requestedAction) && !explicitlyRequestsLipKissing(requestedAction)
  const relationshipPrompt = explicitlyRequestsLipKissing(requestedAction) ? '' : `${familyAffectionNegativePrompt}, `
  const noKissPrompt = requestedNoKiss ? 'kissing, kiss on the lips, mouth-to-mouth kiss, lips touching, mouth contact, face-to-face kiss, romantic kissing, ' : ''
  return `${relationshipPrompt}${noKissPrompt}frozen subjects, still image, slideshow, new people, extra people, duplicated people, extra faces, duplicate face, changed identity, face morphing, age change, different people, missing people, added props, collage, split screen, scene change, camera movement, zoom, crop, reframing, distorted faces, distorted hands, text, watermark`
}

const generateMediaSequence = async (body, generation) => {
  const items = Array.isArray(body.items)
    ? body.items
    : (Array.isArray(body.images) ? body.images.map((data) => ({ kind: 'image', data })) : [])
  if (items.length < 1) throw new Error('Add at least one image or video to the sequence.')
  if (items.length > 20) throw new Error('A sequence can contain up to 20 media items.')
  const imageDuration = Number(body.duration)
  if (!Number.isFinite(imageDuration) || imageDuration < 1 || imageDuration > 30) throw new Error('Each image must be between 1 and 30 seconds.')
  const id = randomUUID()
  const temporaryFiles = []
  const segmentFiles = []
  const segmentDurations = []
  const sequencePath = path.join(uploadDirectory, `${id}-sequence.mp4`)
  temporaryFiles.push(sequencePath)
  await mkdir(uploadDirectory, { recursive: true })
  const aspectDimensions = { '9:16': [720, 1280], '4:5': [720, 900], '3:4': [720, 960], '1:1': [900, 900], '16:9': [1280, 720] }
  const [frameWidth, frameHeight] = body.exportPreset?.startsWith('facebook-')
    ? facebookDimensions[body.exportPreset] || facebookDimensions['facebook-reel']
    : aspectDimensions[body.aspectRatio] || aspectDimensions['9:16']
  const normalizeSegment = async (sourcePath, outputPath, duration) => {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', sourcePath])
    const hasAudio = !body.muteOriginalAudio && (JSON.parse(stdout).streams || []).some((stream) => stream.codec_type === 'audio')
    const args = ['-y', '-i', sourcePath]
    if (!hasAudio) args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100')
    args.push('-vf', `scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=decrease,pad=${frameWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1`, '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0', '-af', 'apad', '-t', String(duration), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', outputPath)
    await execFileAsync('ffmpeg', args)
  }
  try {
    for (let index = 0; index < items.length; index += 1) {
      if (generation.cancelled) return null
      const item = items[index]
      const segmentPath = path.join(uploadDirectory, `${id}-${index + 1}-segment.mp4`)
      temporaryFiles.push(segmentPath)
      segmentFiles.push(segmentPath)
      if (item.kind === 'video') {
        const match = /^data:(video\/(?:mp4|webm|quicktime|x-matroska));base64,(.+)$/.exec(item.data || '')
        if (!match) throw new Error(`Sequence video ${index + 1} is not a supported MP4, WebM, MOV, or MKV file.`)
        const extension = { mp4: 'mp4', webm: 'webm', quicktime: 'mov', 'x-matroska': 'mkv' }[match[1].slice('video/'.length)]
        const sourcePath = path.join(uploadDirectory, `${id}-${index + 1}-source.${extension}`)
        temporaryFiles.push(sourcePath)
        await writeFile(sourcePath, Buffer.from(match[2], 'base64'))
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', sourcePath])
        const duration = Number(stdout.trim())
        if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Unable to read the duration of video ${index + 1}.`)
        if (duration > 1200) throw new Error('Each imported video must be 20 minutes or shorter.')
        segmentDurations.push(duration)
        await normalizeSegment(sourcePath, segmentPath, duration)
      } else {
        const match = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/.exec(item.data || '')
        if (!match) throw new Error(`Sequence image ${index + 1} is not a valid PNG, JPEG, or WebP image.`)
        const imagePath = path.join(uploadDirectory, `${id}-${index + 1}.png`)
        const generatedPath = path.join(uploadDirectory, `${id}-${index + 1}-animated.mp4`)
        temporaryFiles.push(imagePath, generatedPath)
        await writeFile(imagePath, Buffer.from(match[1], 'base64'))
        segmentDurations.push(imageDuration)
        if (item.animate === false) {
          await execFileAsync('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-i', imagePath, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-vf', `scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=decrease,pad=${frameWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`, '-map', '0:v:0', '-map', '1:a:0', '-t', String(imageDuration), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', segmentPath])
        } else {
          const motionPrompt = buildImageMotionPrompt(typeof body.prompt === 'string' ? body.prompt : '')
          const ltxResponse = await postJson(`${backendUrl}/api/generate`, { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, JSON.stringify({ prompt: motionPrompt, negativePrompt: buildImageNegativePrompt(typeof body.prompt === 'string' ? body.prompt : ''), cameraMotion: 'static', duration: imageDuration, resolution: '720p', model: 'fast', fps: 24, aspectRatio: body.aspectRatio === '4:5' ? '9:16' : body.aspectRatio, imagePath }))
          if (generation.cancelled) return null
          const result = JSON.parse(ltxResponse.body)
          if (ltxResponse.status < 200 || ltxResponse.status >= 300 || result.status !== 'complete' || !result.video_path) throw new Error(result.message || `LTX could not animate image ${index + 1}.`)
          await normalizeSegment(result.video_path, segmentPath, imageDuration)
          await rm(result.video_path, { force: true })
          if (result.video_path !== generatedPath) temporaryFiles.push(result.video_path)
        }
      }
    }
    if (generation.cancelled) return null
    const transitionDuration = Math.min(0.4, ...segmentDurations.map((duration) => duration / 2))
    const ffmpegArgs = ['-y']
    for (const segmentPath of segmentFiles) ffmpegArgs.push('-i', segmentPath)
    const filters = segmentFiles.map((_, index) => `[${index}:v]fps=30,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${index}];[${index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`)
    let previousVideo = 'v0'
    let previousAudio = 'a0'
    let elapsedDuration = segmentDurations[0]
    for (let index = 1; index < items.length; index += 1) {
      const videoOutput = `xf${index}`
      const audioOutput = `af${index}`
      const offset = elapsedDuration - transitionDuration
      filters.push(`[${previousVideo}][v${index}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[${videoOutput}]`)
      filters.push(`[${previousAudio}][a${index}]acrossfade=d=${transitionDuration}:c1=tri:c2=tri[${audioOutput}]`)
      previousVideo = videoOutput
      previousAudio = audioOutput
      elapsedDuration += segmentDurations[index] - transitionDuration
    }
    const totalDuration = segmentDurations.reduce((total, duration) => total + duration, 0) - transitionDuration * Math.max(0, segmentDurations.length - 1)
    ffmpegArgs.push('-filter_complex', filters.join(';'), '-map', `[${previousVideo}]`, '-map', `[${previousAudio}]`, '-t', String(totalDuration), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', sequencePath)
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
    const { stdout: streamInfo } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', videoPath])
    const keepOriginalAudio = body.preserveOriginalAudio && (JSON.parse(streamInfo).streams || []).some((stream) => stream.codec_type === 'audio')
    const audioFilter = keepOriginalAudio ? '[0:a:0]volume=0.25[original];[1:a:0]apad[music];[original][music]amix=inputs=2:duration=longest:dropout_transition=2[aout]' : '[1:a:0]apad[aout]'
    await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-ss', String(trimStart), '-i', audioPath, '-filter_complex', audioFilter, '-map', '0:v:0', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', mixedPath])
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
    cameraMotion: 'static',
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
  if (request.method === 'POST' && request.url === '/translate-prompt') {
    try {
      const body = await readJson(request)
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('Enter an Italian prompt to translate.')
      if (body.prompt.length > 1000) throw new Error('The prompt must be 1,000 characters or fewer.')
      send(response, 200, { translatedPrompt: await translatePromptLocally(body.prompt.trim()) })
    } catch (error) {
      await logError('translate-prompt', error)
      send(response, 502, { message: error instanceof Error ? error.message : 'Local prompt translation failed.' })
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
      const result = await generateMediaSequence(await readJson(request), generation)
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
    const prompt = buildImageMotionPrompt(typeof body.prompt === 'string' ? body.prompt : '')
    const negativePrompt = buildImageNegativePrompt(typeof body.prompt === 'string' ? body.prompt : '')
    const ltxResponse = await postJson(`${backendUrl}/api/generate`, { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, JSON.stringify({ prompt, negativePrompt, cameraMotion: 'static', duration, resolution, model: 'fast', fps: 24, aspectRatio: generationAspect, imagePath: filePath }))
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
