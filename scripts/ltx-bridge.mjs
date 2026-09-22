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
          response.on('end', () => resolve({ status: response.statusCode || 500, body: Buffer.concat(chunks).toString('utf8') }))
          response.on('error', reject)
        })
        request.on('timeout', () => request.destroy(new Error('LTX request timed out.')))
        request.on('error', reject)
        request.end(body)
      })
    } catch (error) {
      if (error?.code !== 'ECONNREFUSED' || attempt === 89) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error('LTX request failed.')
}

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
    await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-stream_loop', '-1', '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', mixedPath])
    const video = await readFile(mixedPath)
    return { mimeType: 'video/mp4', data: video.toString('base64') }
  } finally {
    await rm(videoPath, { force: true })
    await rm(audioPath, { force: true })
  }
}

const generateContinuation = async (videoPath, duration, prompt, aspectRatio, id) => {
  const framePath = path.join(uploadDirectory, `${id}-last-frame.png`)
  const continuationPath = path.join(uploadDirectory, `${id}-continuation.mp4`)
  const { stdout: dimensionsOutput } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', videoPath])
  const [sourceWidth, sourceHeight] = dimensionsOutput.trim().split('x').map(Number)
  await execFileAsync('ffmpeg', ['-y', '-sseof', '-0.1', '-i', videoPath, '-frames:v', '1', framePath])
  const imageData = `data:image/png;base64,${(await readFile(framePath)).toString('base64')}`
  const ltxResponse = await postJson(`${backendUrl}/api/generate`, { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, JSON.stringify({
    prompt: `${prompt || 'Continue the natural movement smoothly from the final frame.'} Continue seamlessly from the starting image. Preserve the people, faces, clothes, setting, and camera framing.`,
    negativePrompt: 'scene change, camera movement, zoom, dolly, pan, crop, identity change, distorted faces, distorted hands',
    cameraMotion: 'none',
    duration,
    resolution: '720p',
    model: 'fast',
    fps: 24,
    aspectRatio,
    imageData,
    imagePath: framePath,
  }))
  const result = JSON.parse(ltxResponse.body)
  if (ltxResponse.status < 200 || ltxResponse.status >= 300 || result.status !== 'complete' || !result.video_path) throw new Error(result.message || 'Unable to generate the continuation.')
  await copyFile(result.video_path, continuationPath)
  await rm(result.video_path, { force: true })
  await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-i', continuationPath, '-filter_complex', `[1:v:0]scale=${sourceWidth}:${sourceHeight}:force_original_aspect_ratio=decrease,pad=${sourceWidth}:${sourceHeight}:(ow-iw)/2:(oh-ih)/2[v1];[0:v:0][v1]concat=n=2:v=1:a=0[v]`, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${id}-joined.mp4`], { cwd: uploadDirectory })
  const joinedPath = path.join(uploadDirectory, `${id}-joined.mp4`)
  await rm(continuationPath, { force: true })
  await rm(framePath, { force: true })
  return joinedPath
}

const extendVideo = async (body) => {
  const id = randomUUID()
  const videoPath = path.join(uploadDirectory, `${id}-extend.input.mp4`)
  try {
    await mkdir(uploadDirectory, { recursive: true })
    await writeDataUrl(body.videoData, videoPath)
    const requestedDuration = Number(body.duration)
    const extendResponse = await postJson(`${backendUrl}/api/extend`, { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, JSON.stringify({ video_path: videoPath, duration: requestedDuration, prompt: body.prompt || '', mode: 'end' }))
    const result = JSON.parse(extendResponse.body)
    let resultPath = result.video_path
    if (extendResponse.status === 409) {
      resultPath = videoPath
      let remainingDuration = requestedDuration
      let part = 0
      while (remainingDuration > 0) {
        const nextDuration = Math.min(remainingDuration, 10)
        const nextPath = await generateContinuation(resultPath, nextDuration, body.prompt, body.aspectRatio || '16:9', `${id}-${part}`)
        if (resultPath !== videoPath) await rm(resultPath, { force: true })
        resultPath = nextPath
        remainingDuration -= nextDuration
        part += 1
      }
    }
    if (!resultPath || (extendResponse.status !== 200 && !resultPath)) throw new Error(result.message || result.detail || 'LTX rejected the video extension.')
    const video = await readFile(resultPath)
    await rm(resultPath, { force: true })
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
    const { stdout } = await execFileAsync('nvidia-smi.exe', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 })
    const [name, total, used] = stdout.trim().split(',').map((value) => value.trim())
    if (name && total) return { gpuName: name, vramTotalMb: Number(total), vramUsedMb: Number(used) || 0 }
  } catch {
    // nvidia-smi is not always on PATH, so use the Windows GPU provider below.
  }
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -gt 0 } | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 5000 })
  const fallback = JSON.parse(stdout.trim())
  return { gpuName: fallback.Name || 'GPU detected locally', vramTotalMb: Math.round(Number(fallback.AdapterRAM || 0) / 1024 / 1024), vramUsedMb: null }
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
  if (request.method !== 'POST' || request.url !== '/generate') {
    send(response, 404, { message: 'Not found' })
    return
  }

  let filePath
  try {
    const body = await readJson(request)
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(body.imageData || '')
    if (!match) throw new Error('The reference image must be PNG, JPEG, or WebP.')
    if (!['16:9', '9:16'].includes(body.aspectRatio)) throw new Error('LTX local I2V supports 16:9 and 9:16 only.')
    await mkdir(uploadDirectory, { recursive: true })
    const extension = match[1].split('/')[1].replace('jpeg', 'jpg')
    filePath = path.join(uploadDirectory, `${randomUUID()}.${extension}`)
    await writeFile(filePath, Buffer.from(match[2], 'base64'))
    const duration = Number(body.duration)
    const resolution = duration > 5 ? '720p' : '1080p'
    const ltxResponse = await postJson(`${backendUrl}/api/generate`, { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, JSON.stringify({ prompt: body.prompt, negativePrompt: body.wantsHandMotion ? 'camera movement, zoom, dolly, pan, crop, reframing, scene change' : '', cameraMotion: body.wantsHandMotion ? 'none' : undefined, duration, resolution, model: 'fast', fps: 24, aspectRatio: body.aspectRatio, imagePath: filePath }))
    const result = JSON.parse(ltxResponse.body)
    if (ltxResponse.status < 200 || ltxResponse.status >= 300 || result.status !== 'complete' || !result.video_path) throw new Error(result.message || 'LTX rejected the generation request.')
    const video = await readFile(result.video_path)
    if (!body.hasMusic) {
      await mkdir(outputDirectory, { recursive: true })
      await copyFile(result.video_path, path.join(outputDirectory, path.basename(result.video_path)))
    }
    await rm(result.video_path, { force: true })
    send(response, 200, { mimeType: 'video/mp4', data: video.toString('base64') })
  } catch (error) {
    await logError('generate', error)
    send(response, 502, { message: error instanceof Error ? error.message : 'LTX bridge failed.' })
  } finally {
    if (filePath) await rm(filePath, { force: true })
  }
})

server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') process.exit(0)
  await logError('server', error)
  process.exit(1)
})

loadConfig().then(() => mkdir(outputDirectory, { recursive: true })).then(() => server.listen(port, '127.0.0.1'))