const express = require('express');
const multer = require('multer');
const { Octokit } = require('@octokit/core');
const path = require('path');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// CORS
app.use(cors({
  origin: 'https://www.centrodecompra.com.br',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

app.use(express.json());

// Garantir que a pasta "upload" exista
async function garantePastaUpload() {
  try {
    await fs.mkdir('upload', { recursive: true });
    const testPath = path.join('upload', '.perm_test');
    await fs.writeFile(testPath, 'teste');
    await fs.unlink(testPath);
  } catch (err) {
    console.error('Erro ao garantir pasta upload com permissão de escrita:', err);
    process.exit(1);
  }
}
garantePastaUpload();

app.use('/upload', express.static(path.join(__dirname, 'upload')));

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Configuração do multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'upload/'),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const nomeProduto = req.body.nome ? req.body.nome.replace(/\s+/g, '-').toLowerCase() : 'produto';
    const ext = path.extname(file.originalname);
    cb(null, `produto_${nomeProduto}-${timestamp}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Apenas imagens são permitidas!'), false);
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter,
});

// Função para upload da imagem para GitHub
async function uploadImagemGitHub(nomeArquivo, caminhoLocal) {
  const conteudoBuffer = await fs.readFile(caminhoLocal);
  const conteudoBase64 = conteudoBuffer.toString('base64');
  const caminhoGitHub = `imagens/${nomeArquivo}`;
  let sha;

  try {
    const resGet = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: caminhoGitHub,
    });
    sha = resGet.data.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
    owner: 'bingaby',
    repo: 'centrodecompra',
    path: caminhoGitHub,
    message: `Upload da imagem ${nomeArquivo}`,
    content: conteudoBase64,
    sha,
    branch: 'main',
  });

  return `https://raw.githubusercontent.com/bingaby/centrodecompra/main/${caminhoGitHub}`;
}

// Função para deletar imagem do GitHub
async function deletarArquivoGitHub(caminhoArquivo) {
  try {
    const resGet = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: caminhoArquivo,
    });
    const sha = resGet.data.sha;
    await octokit.request('DELETE /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: caminhoArquivo,
      message: `Remove arquivo ${caminhoArquivo}`,
      sha,
      branch: 'main',
    });
  } catch (error) {
    console.warn(`Aviso: erro ao deletar imagem no GitHub (${caminhoArquivo}): ${error.message}`);
  }
}

// GET produtos com paginação
app.get('/api/produtos', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const skip = limit ? (page - 1) * limit : 0;

    console.log(`Requisição GET /api/produtos: page=${page}, limit=${limit || 'nenhum'}, skip=${skip}`);

    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: 'produtos.json',
    });

    const produtos = JSON.parse(Buffer.from(response.data.content, 'base64').toString());
    const total = produtos.length;

    const produtosPaginados = limit ? produtos.slice(skip, skip + limit) : produtos;

    console.log(`Retornando ${produtosPaginados.length} produtos, Total: ${total}`);

    res.json({ produtos: produtosPaginados, total });
  } catch (error) {
    if (error.status === 404) return res.json({ produtos: [], total: 0 });
    console.error('Erro na rota GET /api/produtos:', error);
    res.status(500).json({ error: 'Erro ao carregar produtos', details: error.message });
  }
});

// GET produto por ID
app.get('/api/produtos/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: 'produtos.json',
    });

    const produtos = JSON.parse(Buffer.from(response.data.content, 'base64').toString());
    const produto = produtos.find(p => p._id === id);

    if (!produto) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }

    res.json(produto);
  } catch (error) {
    console.error('Erro na rota GET /api/produtos/:id:', error);
    res.status(500).json({ error: 'Erro ao buscar produto', details: error.message });
  }
});

// POST produto
app.post('/api/produtos', upload.array('imagens', 3), async (req, res) => {
  try {
    const { nome, descricao, categoria, loja, link, preco } = req.body;

    if (!nome || !categoria || !loja || !link || !preco) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }

    const precoFloat = parseFloat(preco);
    if (isNaN(precoFloat) || precoFloat < 0) {
      return res.status(400).json({ error: 'Preço inválido' });
    }

    const imagens = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const urlImagem = await uploadImagemGitHub(file.filename, file.path);
        imagens.push(urlImagem);
        await fs.unlink(file.path);
      }
    }

    let produtos = [];
    let sha;
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: 'bingaby',
        repo: 'centrodecompra',
        path: 'produtos.json',
      });
      produtos = JSON.parse(Buffer.from(response.data.content, 'base64').toString());
      sha = response.data.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    const novoProduto = {
      _id: `${Date.now()}${Math.random().toString(36).substr(2, 9)}`,
      nome,
      descricao,
      categoria,
      loja,
      link,
      preco: precoFloat,
      imagens,
    };

    produtos.push(novoProduto);

    const jsonContent = JSON.stringify(produtos, null, 2);

    await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: 'produtos.json',
      message: 'Adiciona novo produto via API',
      content: Buffer.from(jsonContent).toString('base64'),
      sha,
      branch: 'main',
    });

    res.status(201).json({ message: 'Produto adicionado com sucesso', produto: novoProduto });
  } catch (error) {
    console.error('Erro ao adicionar produto:', error);
    res.status(500).json({ error: error.message || 'Erro ao adicionar produto' });
  }
});

// PUT produto
app.put('/api/produtos/:id', upload.array('imagens', 3), async (req, res) => {
  try {
    const id = req.params.id;
    const { nome, descricao, categoria, loja, link, preco } = req.body;

    if (!nome || !categoria || !loja || !link || !preco) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }

    const precoFloat = parseFloat(preco);
    if (isNaN(precoFloat) || precoFloat < 0) {
      return res.status(400).json({ error: 'Preço inválido' });
    }

    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: 'produtos.json',
    });

    let produtos = JSON.parse(Buffer.from(response.data.content, 'base64').toString());
    const sha = response.data.sha;

    const produtoIndex = produtos.findIndex(p => p._id === id);
    if (produtoIndex === -1) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }

    const imagens = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const urlImagem = await uploadImagemGitHub(file.filename, file.path);
        imagens.push(urlImagem);
        await fs.unlink(file.path);
      }
    }

    // Manter imagens existentes se nenhuma nova for enviada
    const imagensAtualizadas = imagens.length > 0 ? imagens : produtos[produtoIndex].imagens;

    // Deletar imagens antigas do GitHub se novas imagens foram enviadas
    if (imagens.length > 0 && produtos[produtoIndex].imagens && produtos[produtoIndex].imagens.length > 0) {
      for (const urlImagem of produtos[produtoIndex].imagens) {
        const urlObj = new URL(urlImagem);
        const caminhoArquivo = urlObj.pathname.split('/').slice(4).join('/');
        await deletarArquivoGitHub(caminhoArquivo);
      }
    }

    produtos[produtoIndex] = {
      _id: id,
      nome,
      descricao,
      categoria,
      loja,
      link,
      preco: precoFloat,
      imagens: imagensAtualizadas,
    };

    const jsonContent = JSON.stringify(produtos, null, 2);

    await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: 'produtos.json',
      message: `Atualiza produto ${id} via API`,
      content: Buffer.from(jsonContent).toString('base64'),
      sha,
      branch: 'main',
    });

    res.json({ message: 'Produto atualizado com sucesso', produto: produtos[produtoIndex] });
  } catch (error) {
    console.error('Erro ao atualizar produto:', error);
    res.status(500).json({ error: error.message || 'Erro ao atualizar produto' });
  }
});

// DELETE produto
app.delete('/api/produtos/:id', async (req, res) => {
  try {
    const id = req.params.id;

    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: 'produtos.json',
    });

    const produtos = JSON.parse(Buffer.from(response.data.content, 'base64').toString());
    const sha = response.data.sha;

    const produtoIndex = produtos.findIndex(p => p._id === id);
    if (produtoIndex === -1) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }

    const produto = produtos[produtoIndex];
    if (produto.imagens && produto.imagens.length > 0) {
      for (const urlImagem of produto.imagens) {
        const urlObj = new URL(urlImagem);
        const caminhoArquivo = urlObj.pathname.split('/').slice(4).join('/');
        await deletarArquivoGitHub(caminhoArquivo);
      }
    }

    produtos.splice(produtoIndex, 1);

    const jsonContent = JSON.stringify(produtos, null, 2);

    await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'bingaby',
      repo: 'centrodecompra',
      path: 'produtos.json',
      message: `Remove produto ${id} via API`,
      content: Buffer.from(jsonContent).toString('base64'),
      sha,
      branch: 'main',
    });

    res.json({ message: 'Produto excluído com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir produto:', error);
    res.status(500).json({ error: 'Erro ao excluir produto' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
