import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryManage } from './MemoryManage'
import * as memoryApi from '../services/memoryApi'

vi.mock('../services/memoryApi', async () => {
  const actual = await vi.importActual<typeof import('../services/memoryApi')>('../services/memoryApi')
  return {
    ...actual,
    fetchUserMemories: vi.fn(),
    addUserMemory: vi.fn(),
    updateUserMemory: vi.fn(),
    deleteUserMemory: vi.fn(),
  }
})

const mocks = vi.mocked(memoryApi)

const mem = (id: string, content: string): memoryApi.UserMemory => ({
  id, content, createdAt: '2026-09-14T08:00:00.000Z', updatedAt: '2026-09-14T08:00:00.000Z',
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchUserMemories.mockResolvedValue({ memories: [], limits: { maxLen: 500, maxPerUser: 100 } })
})

describe('MemoryManage', () => {
  it('打开后拉取当前用户记忆，空列表显示引导文案', async () => {
    render(<MemoryManage username="alice" onClose={() => {}} />)
    expect(await screen.findByText(/还没有记忆/)).toBeInTheDocument()
    expect(mocks.fetchUserMemories).toHaveBeenCalledWith('alice')
  })

  it('添加记忆：调用接口后刷新列表并通知父级', async () => {
    const onChanged = vi.fn()
    mocks.addUserMemory.mockResolvedValue({ memories: [mem('mem-1', 'SQL 列名注释要加双引号')] })
    render(<MemoryManage username="alice" onClose={() => {}} onChanged={onChanged} />)
    await screen.findByText(/还没有记忆/)
    fireEvent.change(screen.getByPlaceholderText(/列名注释/), { target: { value: 'SQL 列名注释要加双引号' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => {
      expect(mocks.addUserMemory).toHaveBeenCalledWith('alice', 'SQL 列名注释要加双引号')
      expect(onChanged).toHaveBeenCalledWith([expect.objectContaining({ id: 'mem-1' })])
    })
    expect(screen.getByText('SQL 列名注释要加双引号')).toBeInTheDocument()
  })

  it('编辑记忆：保存后调用更新接口', async () => {
    mocks.fetchUserMemories.mockResolvedValue({ memories: [mem('mem-9', '旧偏好')] })
    mocks.updateUserMemory.mockResolvedValue({ memories: [mem('mem-9', '新偏好')] })
    render(<MemoryManage username="bob" onClose={() => {}} />)
    await screen.findByText('旧偏好')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const box = screen.getByDisplayValue('旧偏好')
    fireEvent.change(box, { target: { value: '新偏好' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.updateUserMemory).toHaveBeenCalledWith('bob', 'mem-9', '新偏好'))
    expect(screen.getByText('新偏好')).toBeInTheDocument()
  })

  it('删除记忆：需二次确认后调用删除接口', async () => {
    mocks.fetchUserMemories.mockResolvedValue({ memories: [mem('mem-5', '要删的偏好')] })
    mocks.deleteUserMemory.mockResolvedValue({ memories: [] })
    render(<MemoryManage username="bob" onClose={() => {}} />)
    await screen.findByText('要删的偏好')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    // 出现确认按钮，直接删除接口还没被调用
    expect(mocks.deleteUserMemory).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(mocks.deleteUserMemory).toHaveBeenCalledWith('bob', 'mem-5'))
  })

  it('接口报错时展示错误信息且不清空列表', async () => {
    mocks.fetchUserMemories.mockResolvedValue({ memories: [mem('mem-1', '保留')] })
    mocks.addUserMemory.mockRejectedValue(new Error('每个用户最多保存 100 条记忆'))
    render(<MemoryManage username="carol" onClose={() => {}} />)
    await screen.findByText('保留')
    fireEvent.change(screen.getByPlaceholderText(/列名注释/), { target: { value: '再添一条' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText(/每个用户最多保存 100 条记忆/)).toBeInTheDocument()
    expect(screen.getByText('保留')).toBeInTheDocument()
  })
})
