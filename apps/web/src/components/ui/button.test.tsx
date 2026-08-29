// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './button'

describe('Button', () => {
  it('renders the element passed to the render prop', () => {
    render(<Button render={<a href="/files" />}>Download</Button>)
    const link = screen.getByRole('link', { name: 'Download' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/files')
  })
})
