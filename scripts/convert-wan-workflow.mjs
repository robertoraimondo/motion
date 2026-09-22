import { readFile, writeFile } from 'node:fs/promises'

const inputPath = 'ComfyUI/workflows/wan_text_to_video.json'
const outputPath = 'public/wan_text_to_video_api.json'
const workflow = JSON.parse(await readFile(inputPath, 'utf8'))
const links = new Map(workflow.links.map(([id, fromNode, fromSlot]) => [id, [String(fromNode), fromSlot]]))
const api = {}

for (const node of workflow.nodes) {
  const inputs = {}
  const linkedInputNames = new Set()
  for (const input of node.inputs ?? []) {
    if (input.link != null && links.has(input.link)) {
      inputs[input.name] = links.get(input.link)
      linkedInputNames.add(input.name)
    }
  }

  const widgetNames = {
    VAELoader: ['vae_name'],
    CLIPLoader: ['clip_name', 'type', 'device'],
    EmptyHunyuanLatentVideo: ['width', 'height', 'length', 'batch_size'],
    KSampler: ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
    ModelSamplingSD3: ['shift'],
    UNETLoader: ['unet_name', 'weight_dtype'],
    SaveAnimatedWEBP: ['filename_prefix', 'fps', 'lossless', 'quality', 'method'],
    SaveWEBM: ['filename_prefix', 'codec', 'fps', 'crf'],
  }
  const names = widgetNames[node.type] ?? []
  names.forEach((name, index) => {
    if (!linkedInputNames.has(name) && node.widgets_values?.[index] !== undefined) inputs[name] = node.widgets_values[index]
  })
  if (node.type === 'CLIPTextEncode' && node.id !== 6) inputs.text = node.widgets_values?.[0] ?? ''

  if (node.id === 6) inputs.text = '{{PROMPT}}'
  if (node.id === 37) inputs.unet_name = 'wan2.1_t2v_1.3B_bf16.safetensors'
  if (node.id === 3) inputs.steps = 12
  if (node.id === 40) {
    inputs.width = 512
    inputs.height = 288
    inputs.length = 17
  }
  api[String(node.id)] = { class_type: node.type, inputs }
}

await writeFile(outputPath, JSON.stringify(api, null, 2))
console.log(`Wrote ${outputPath}`)
