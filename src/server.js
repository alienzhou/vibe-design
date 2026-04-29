import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE = join(__dirname, '..', 'workspace');

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// 状态存储
let currentState = {
  round: 0,
  phase: 'explore',
  variants: [],
  scores: {},
  userDescription: ''
};

// 确保 workspace 存在
if (!existsSync(WORKSPACE)) {
  mkdirSync(WORKSPACE, { recursive: true });
}

// 调用 Claude Code 生成变体
async function generateWithClaude(prompt, outputDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-dir', outputDir
    ];

    console.log('Calling Claude Code with args:', args);

    const claude = spawn('claude', args, {
      cwd: outputDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let error = '';

    claude.stdout.on('data', (data) => {
      output += data.toString();
      console.log('Claude stdout:', data.toString());
    });

    claude.stderr.on('data', (data) => {
      error += data.toString();
      console.error('Claude stderr:', data.toString());
    });

    claude.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude Code exited with code ${code}: ${error}`));
      } else {
        resolve(output);
      }
    });

    setTimeout(() => {
      claude.kill();
      reject(new Error('Claude Code timed out'));
    }, 120000);
  });
}

// 生成变体的 Prompt 构建
function buildGenerationPrompt(description, round, phase, previousScores = []) {
  const roundDir = join(WORKSPACE, `round-${round}`);

  if (round === 1) {
    return `Generate 6 different UI design variations for: "${description}"

Requirements:
- Each variation should have distinctly different styles (color schemes, layouts, typography)
- Output 6 separate HTML files with inline CSS
- Files should be named: variant-1.html, variant-2.html, ... variant-6.html
- Each file should be a complete, standalone page
- Save all files to: ${roundDir}

Make sure each design feels unique and explores different aesthetic directions.`;
  }

  const highRated = previousScores.filter(s => s.rating >= 4);
  const lowRated = previousScores.filter(s => s.rating <= 2);

  let feedback = '';
  if (highRated.length > 0) {
    feedback += `High-rated styles (4-5 stars): ${highRated.map(s => s.variantId).join(', ')} - continue these directions\n`;
  }
  if (lowRated.length > 0) {
    feedback += `Low-rated styles (0-2 stars): ${lowRated.map(s => s.variantId).join(', ')} - avoid these features\n`;
  }

  return `Generate 6 UI design variations for: "${description}"

Round: ${round}
Phase: ${phase}

User Feedback from Previous Round:
${feedback}

Requirements:
- Keep and refine high-rated style directions
- Replace low-rated directions with new style explorations
- Output 6 separate HTML files with inline CSS
- Files: variant-1.html through variant-6.html
- Save to: ${roundDir}

Balance between maintaining what worked and exploring new directions.`;
}

// API: 开始新探索
app.post('/api/start', async (req, res) => {
  try {
    const { description } = req.body;
    currentState = {
      round: 1,
      phase: 'explore',
      variants: [],
      scores: {},
      userDescription: description
    };

    const roundDir = join(WORKSPACE, 'round-1');
    if (!existsSync(roundDir)) {
      mkdirSync(roundDir, { recursive: true });
    }

    const prompt = buildGenerationPrompt(description, 1, 'explore');

    res.json({ status: 'generating', round: 1, message: 'Generating initial variations...' });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: 获取当前变体列表
app.get('/api/variants', (req, res) => {
  const roundDir = join(WORKSPACE, `round-${currentState.round}`);
  const variants = [];

  if (existsSync(roundDir)) {
    const files = readdirSync(roundDir).filter(f => f.endsWith('.html'));
    files.forEach((file, index) => {
      variants.push({
        id: `variant-${index + 1}`,
        round: currentState.round,
        filename: file,
        path: `/workspace/round-${currentState.round}/${file}`
      });
    });
  }

  currentState.variants = variants;
  res.json({
    round: currentState.round,
    phase: currentState.phase,
    variants,
    description: currentState.userDescription
  });
});

// API: 提交评分
app.post('/api/score', (req, res) => {
  const { variantId, rating } = req.body;
  currentState.scores[variantId] = { variantId, rating, timestamp: Date.now() };
  res.json({ status: 'ok', scores: currentState.scores });
});

// API: 提交所有评分并生成下一轮
app.post('/api/next-round', async (req, res) => {
  try {
    const scores = Object.values(currentState.scores);

    const highScores = scores.filter(s => s.rating >= 4).length;
    const hasConvergence = currentState.round >= 3 && highScores >= 2;

    if (hasConvergence && currentState.phase === 'explore') {
      currentState.phase = 'converge';
    }

    currentState.round++;
    currentState.scores = {};

    const roundDir = join(WORKSPACE, `round-${currentState.round}`);
    if (!existsSync(roundDir)) {
      mkdirSync(roundDir, { recursive: true });
    }

    const prompt = buildGenerationPrompt(
      currentState.userDescription,
      currentState.round,
      currentState.phase,
      scores
    );

    res.json({
      status: 'generating',
      round: currentState.round,
      phase: currentState.phase,
      message: 'Generating next round variations...'
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 静态文件服务：workspace 中的变体
app.use('/workspace', express.static(WORKSPACE));

// 获取特定变体内容
app.get('/api/variant/:id', (req, res) => {
  const { id } = req.params;
  const filename = `${id}.html`;
  const filepath = join(WORKSPACE, `round-${currentState.round}`, filename);

  if (existsSync(filepath)) {
    const content = readFileSync(filepath, 'utf-8');
    res.json({ id, content });
  } else {
    res.status(404).json({ error: 'Variant not found' });
  }
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`Design Explorer running at http://localhost:${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
});
